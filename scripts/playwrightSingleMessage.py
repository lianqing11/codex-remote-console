import asyncio
import json
import os
import pathlib
import sqlite3
import subprocess
import tempfile
import time

from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""
STATE_DIR = pathlib.Path(
    os.environ.get("CODING_AGENT_CONSOLE_STATE_DIR")
    or pathlib.Path.home() / ".local" / "share" / "coding-agent-console"
)
QUEUE_DATABASE = STATE_DIR / "queue.sqlite"


def queue_rows(prompts: tuple[str, ...]) -> list[tuple[str, str, str | None, int, str]]:
    if not QUEUE_DATABASE.exists():
        return []
    placeholders = ",".join("?" for _ in prompts)
    with sqlite3.connect(f"file:{QUEUE_DATABASE}?mode=ro", uri=True, timeout=5) as connection:
        return connection.execute(
            f"SELECT id, status, run_id, attempts, text FROM queue_items "
            f"WHERE text IN ({placeholders}) ORDER BY created_at",
            prompts,
        ).fetchall()


async def wait_for_queue_rows(
    prompts: tuple[str, ...],
    expected_statuses: set[str],
    timeout_seconds: int,
) -> list[tuple[str, str, str | None, int, str]]:
    deadline = time.monotonic() + timeout_seconds
    rows: list[tuple[str, str, str | None, int, str]] = []
    while time.monotonic() < deadline:
        rows = queue_rows(prompts)
        if len(rows) == len(prompts) and {row[1] for row in rows}.issubset(expected_statuses):
            return rows
        await asyncio.sleep(0.25)
    raise AssertionError(f"Queue rows did not reach {expected_statuses}: {rows}")


async def sign_in(page) -> None:
    await page.goto(URL, wait_until="networkidle")
    password_input = page.locator('input[placeholder="Password or token"]')
    if await password_input.count():
        assert PASSWORD, "CODEX_WEB_PASSWORD or CODEX_WEB_TOKEN is required."
        await password_input.fill(PASSWORD)
        await page.get_by_role("button", name="Sign in").click()
    await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
    await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)


async def wait_for_agent_marker(page, marker: str, timeout_seconds: int = 180) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        panels = page.locator("details.turnPanel")
        for index in range(await panels.count()):
            panel = panels.nth(index)
            if not await panel.evaluate("element => element.open"):
                await panel.locator("summary").click()
        if await page.locator(".message.agentMessage", has_text=marker).count():
            return
        await asyncio.sleep(0.25)
    raise AssertionError(f"Timed out waiting for assistant marker {marker}")


async def matching_user_card_count(page, marker: str) -> int:
    return await page.locator(".message.userMessage", has_text=marker).count()


async def probe_snapshot(page, phase: str) -> dict:
    snapshot = await page.evaluate(
        """
        phase => ({
          phase,
          samples: window.__singleMessageProbe?.samples || 0,
          maxCounts: window.__singleMessageProbe?.maxCounts || {},
          currentCounts: window.__singleMessageProbe?.currentCounts || {}
        })
        """,
        phase,
    )
    assert snapshot["samples"] > 0, snapshot
    for marker, count in snapshot["maxCounts"].items():
        assert count <= 1, f"{phase}: {marker} rendered {count} matching user cards"
    return snapshot


async def main() -> None:
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="coding-agent-console-single-card-"))
    subprocess.run(["git", "init", str(workspace)], check=True, capture_output=True, text=True)

    nonce = str(time.time_ns())
    codex_marker = f"SINGLE_CODEX_{nonce}"
    cursor_first_marker = f"SINGLE_CURSOR_FIRST_{nonce}"
    cursor_second_marker = f"SINGLE_CURSOR_SECOND_{nonce}"
    markers = (codex_marker, cursor_first_marker, cursor_second_marker)
    codex_prompt = f"Do not use tools or modify files. Reply with exactly {codex_marker}."
    cursor_first_prompt = (
        "Use the terminal to run `sleep 12` without modifying files. "
        f"After it finishes, reply with exactly {cursor_first_marker}."
    )
    cursor_second_prompt = (
        f"Do not use tools or modify files. Reply with exactly {cursor_second_marker}."
    )
    prompts = (codex_prompt, cursor_first_prompt, cursor_second_prompt)

    probe_script = f"""
      (() => {{
        const markers = {json.dumps(markers)};
        const probe = {{
          samples: 0,
          maxCounts: Object.fromEntries(markers.map(marker => [marker, 0])),
          currentCounts: Object.fromEntries(markers.map(marker => [marker, 0]))
        }};
        window.__singleMessageProbe = probe;
        window.setInterval(() => {{
          const cards = [...document.querySelectorAll('.message.userMessage')];
          probe.samples += 1;
          for (const marker of markers) {{
            const count = cards.filter(card => (card.textContent || '').includes(marker)).length;
            probe.currentCounts[marker] = count;
            probe.maxCounts[marker] = Math.max(probe.maxCounts[marker], count);
          }}
        }}, 50);
      }})();
    """

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 1000})
        await context.add_init_script(script=probe_script)
        page = await context.new_page()
        console_errors: list[str] = []
        page_errors: list[str] = []
        http_5xx: list[str] = []
        websocket_message_types: set[str] = set()

        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "response",
            lambda response: http_5xx.append(f"{response.status} {response.url}")
            if response.status >= 500
            else None,
        )

        def watch_websocket(socket) -> None:
            def record_frame(frame) -> None:
                try:
                    payload = json.loads(frame)
                except (TypeError, json.JSONDecodeError):
                    return
                if isinstance(payload, dict) and isinstance(payload.get("type"), str):
                    websocket_message_types.add(payload["type"])

            socket.on("framereceived", record_frame)

        page.on("websocket", watch_websocket)

        await sign_in(page)
        await page.evaluate(
            """
            ([cwd]) => {
              localStorage.setItem('coding-agent-console.cwd', cwd);
              localStorage.setItem('coding-agent-console.recentDirs', JSON.stringify([cwd]));
              localStorage.setItem('coding-agent-console.provider', 'codex');
              localStorage.setItem(
                'coding-agent-console.cursor.runtime',
                JSON.stringify({provider: 'cursor', model: 'auto', mode: 'default'})
              );
            }
            """,
            [str(workspace)],
        )
        await page.reload(wait_until="networkidle")
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        await page.get_by_text(workspace.name, exact=False).first.wait_for(state="visible", timeout=20_000)

        # Codex normal send: the optimistic input remains visible immediately,
        # then the official current-turn user item takes over without overlap.
        await page.get_by_role("button", name="New session", exact=True).click()
        await page.get_by_role("button", name="New Codex", exact=True).click()
        codex_composer = page.locator('textarea[placeholder^="Send a task to Codex"]')
        await codex_composer.wait_for(state="visible", timeout=30_000)
        await codex_composer.fill(codex_prompt)
        await page.locator("button.primaryButton", has_text="Send").click()
        await page.locator(".message.userMessage", has_text=codex_marker).wait_for(
            state="visible", timeout=30_000
        )
        await wait_for_agent_marker(page, codex_marker)
        await page.get_by_role("button", name="Stop").wait_for(state="hidden", timeout=30_000)
        assert await matching_user_card_count(page, codex_marker) == 1
        phase_results = [await probe_snapshot(page, "codex-normal")]

        # Cursor's tool run creates a deterministic active window. A second
        # unique prompt is queued during the run, then the browser reconnects.
        await page.get_by_role("button", name="New session", exact=True).click()
        await page.locator(".emptyStateActions").get_by_role("radio", name="Cursor").click()
        new_cursor = page.get_by_role("button", name="New Cursor", exact=True)
        await new_cursor.wait_for(state="visible", timeout=90_000)
        await new_cursor.click()
        cursor_composer = page.locator(".composer textarea")
        await cursor_composer.wait_for(state="visible", timeout=90_000)
        await cursor_composer.fill(cursor_first_prompt)
        await page.locator("button.primaryButton", has_text="Send").click()
        await page.get_by_role("button", name="Stop").wait_for(state="visible", timeout=90_000)
        await page.locator(".message.userMessage", has_text=cursor_first_marker).wait_for(
            state="visible", timeout=30_000
        )

        await cursor_composer.fill(cursor_second_prompt)
        await page.locator("button.primaryButton", has_text="Send").click()
        await page.locator(".message.userMessage", has_text=cursor_second_marker).wait_for(
            state="visible", timeout=30_000
        )
        active_rows = await wait_for_queue_rows(
            (cursor_first_prompt, cursor_second_prompt),
            {"queued", "dispatching", "running", "waiting_for_input"},
            30,
        )
        assert any(row[1] == "queued" for row in active_rows), active_rows
        await page.locator(".queueStatusBar").wait_for(state="visible", timeout=20_000)
        phase_results.append(await probe_snapshot(page, "cursor-queued-before-refresh"))

        await page.reload(wait_until="networkidle")
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=30_000)
        workspace_group = page.locator(
            f'section.threadGroup:has(.threadGroupPath[title="{workspace}"])'
        )
        cursor_thread = workspace_group.locator(
            '.fleetSessionRow[data-session-key^="cursor:"]'
        ).first
        await cursor_thread.wait_for(state="visible", timeout=60_000)
        await cursor_thread.locator(".fleetSessionMain").click()
        await workspace_group.locator(
            '.fleetSessionRow.selected[data-session-key^="cursor:"]'
        ).wait_for(state="visible", timeout=30_000)
        await page.wait_for_timeout(250)
        phase_results.append(await probe_snapshot(page, "cursor-refresh-reconnect"))

        completed_rows = await wait_for_queue_rows(prompts, {"completed"}, 240)
        codex_thread = workspace_group.locator(
            '.fleetSessionRow[data-session-key^="codex:"]'
        ).first
        await codex_thread.locator(".fleetSessionMain").click()
        await workspace_group.locator(
            '.fleetSessionRow.selected[data-session-key^="codex:"]'
        ).wait_for(state="visible", timeout=30_000)
        await cursor_thread.locator(".fleetSessionMain").click()
        await workspace_group.locator(
            '.fleetSessionRow.selected[data-session-key^="cursor:"]'
        ).wait_for(state="visible", timeout=30_000)
        await wait_for_agent_marker(page, cursor_first_marker)
        await wait_for_agent_marker(page, cursor_second_marker)
        await page.get_by_role("button", name="Stop").wait_for(state="hidden", timeout=30_000)
        await page.wait_for_timeout(250)
        phase_results.append(await probe_snapshot(page, "all-completed"))

        for marker in markers:
            assert await matching_user_card_count(page, marker) == (
                0 if marker == codex_marker else 1
            ), f"unexpected visible official card count for {marker}"
        assert len(completed_rows) == 3
        assert all(row[2] for row in completed_rows), completed_rows
        assert all(row[3] == 1 for row in completed_rows), completed_rows
        assert len({row[0] for row in completed_rows}) == 3
        assert {"agent:snapshot", "queue:snapshot"}.issubset(websocket_message_types), websocket_message_types
        assert not console_errors, console_errors
        assert not page_errors, page_errors
        assert not http_5xx, http_5xx

        print(
            json.dumps(
                {
                    "url": URL,
                    "workspace": str(workspace),
                    "queueDatabase": str(QUEUE_DATABASE),
                    "sampleIntervalMs": 50,
                    "phases": phase_results,
                    "queueRows": [
                        {
                            "id": row[0],
                            "status": row[1],
                            "runId": row[2],
                            "attempts": row[3],
                            "marker": next(marker for marker in markers if marker in row[4]),
                        }
                        for row in completed_rows
                    ],
                    "websocketSnapshots": sorted(websocket_message_types),
                    "consoleErrors": console_errors,
                    "pageErrors": page_errors,
                    "http5xx": http_5xx,
                },
                indent=2,
            )
        )
        await browser.close()


try:
    asyncio.run(main())
except PlaywrightTimeoutError as error:
    raise AssertionError(f"Playwright timed out: {error}") from error
