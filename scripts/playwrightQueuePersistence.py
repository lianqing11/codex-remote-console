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


def queue_rows(prompts: tuple[str, str]) -> list[tuple[str, str, str | None]]:
    if not QUEUE_DATABASE.exists():
        return []
    with sqlite3.connect(f"file:{QUEUE_DATABASE}?mode=ro", uri=True, timeout=5) as connection:
        return connection.execute(
            "SELECT id, status, run_id FROM queue_items WHERE text IN (?, ?) ORDER BY created_at",
            prompts,
        ).fetchall()


async def wait_for_queue_status(
    prompts: tuple[str, str],
    expected: set[str],
    timeout_seconds: int,
) -> list[tuple[str, str, str | None]]:
    deadline = time.monotonic() + timeout_seconds
    rows: list[tuple[str, str, str | None]] = []
    while time.monotonic() < deadline:
        rows = queue_rows(prompts)
        if len(rows) == 2 and {row[1] for row in rows}.issubset(expected):
            return rows
        await asyncio.sleep(0.5)
    raise AssertionError(f"Queue did not reach {expected}: {rows}")


async def sign_in(page) -> None:
    await page.goto(URL, wait_until="networkidle")
    password_input = page.locator('input[placeholder="Password or token"]')
    if await password_input.count():
        assert PASSWORD, "CODEX_WEB_PASSWORD or CODEX_WEB_TOKEN is required."
        await password_input.fill(PASSWORD)
        await page.get_by_role("button", name="Sign in").click()
    await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
    await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)


async def wait_for_response_markers(page, markers: tuple[str, str], timeout_seconds: int = 60) -> list[str]:
    deadline = time.monotonic() + timeout_seconds
    texts: list[str] = []
    while time.monotonic() < deadline:
        panels = page.locator("details.turnPanel")
        for index in range(await panels.count()):
            panel = panels.nth(index)
            if not await panel.evaluate("element => element.open"):
                await panel.locator("summary").click()
        texts = await page.locator(".message.agentMessage").all_inner_texts()
        combined = "\n".join(texts)
        if all(marker in combined for marker in markers):
            return texts
        await asyncio.sleep(0.5)
    raise AssertionError(f"Reopened session did not render both completed responses: {texts}")


async def main() -> None:
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="coding-agent-console-queue-persistence-"))
    subprocess.run(["git", "init", str(workspace)], check=True, capture_output=True, text=True)
    marker = str(time.time_ns())
    first_marker = f"QUEUE_FIRST_{marker}"
    second_marker = f"QUEUE_SECOND_{marker}"
    first_prompt = (
        "Use the terminal to run `sleep 20` without modifying any files. "
        f"After it finishes, reply with exactly {first_marker}."
    )
    second_prompt = f"Do not use tools or modify files. Reply with exactly {second_marker}."
    prompts = (first_prompt, second_prompt)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 1000})
        page = await context.new_page()
        console_errors: list[str] = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

        await sign_in(page)
        await page.evaluate(
            "([cwd]) => { localStorage.setItem('coding-agent-console.cwd', cwd); "
            "localStorage.setItem('coding-agent-console.recentDirs', JSON.stringify([cwd])); "
            "localStorage.setItem('coding-agent-console.provider', 'cursor'); "
            "localStorage.setItem('coding-agent-console.runtime.cursor', "
            "JSON.stringify({provider: 'cursor', model: 'auto', mode: 'agent'})); }",
            [str(workspace)],
        )
        await page.reload(wait_until="networkidle")
        await page.get_by_role("button", name="New session").click()
        await page.get_by_role("radio", name="Cursor").wait_for(state="visible", timeout=30_000)
        new_session = page.locator("button.newSessionPrimary", has_text="New Cursor")
        await new_session.wait_for(state="visible", timeout=30_000)
        assert await new_session.is_enabled()
        await new_session.click()
        await page.get_by_text("send a task to create the session", exact=False).wait_for(state="visible", timeout=10_000)
        await page.locator(".sessionModeSwitch button.active", has_text="Agent").wait_for(state="visible", timeout=30_000)

        composer = page.locator(".composer textarea")
        await composer.fill(first_prompt)
        await page.locator("button.primaryButton", has_text="Send").click()
        await page.get_by_role("button", name="Stop").wait_for(state="visible", timeout=30_000)

        await composer.fill(second_prompt)
        await page.locator("button.primaryButton").click()
        await wait_for_queue_status(prompts, {"dispatching", "running", "waiting_for_input", "queued"}, 20)
        queue_bar = page.locator(".queueStatusBar")
        await queue_bar.wait_for(state="visible", timeout=20_000)
        visible_queue_count = int(await queue_bar.locator(".queueCount").inner_text())
        assert visible_queue_count >= 1
        await queue_bar.locator(".queueStatusToggle").click()
        assert await queue_bar.locator(".queueStatusItem").count() >= 1
        await queue_bar.locator(".queueStatusItem", has_text=second_marker).wait_for(
            state="visible", timeout=10_000
        )

        # Close every page while the first task is still in flight. Completion
        # below is observed directly from server-owned SQLite state.
        await page.close()
        assert len(context.pages) == 0
        completed_rows = await wait_for_queue_status(prompts, {"completed"}, 240)
        assert all(row[2] for row in completed_rows), completed_rows

        reopened = await context.new_page()
        await sign_in(reopened)
        workspace_group = reopened.locator(".threadGroup").filter(has_text=workspace.name)
        cursor_thread = workspace_group.locator(".fleetSessionRow").filter(has_text="Cursor").first
        await cursor_thread.wait_for(state="visible", timeout=30_000)
        await cursor_thread.click()
        await wait_for_response_markers(reopened, (first_marker, second_marker))
        assert await reopened.locator(".queueStatusBar").count() == 0
        assert not console_errors, console_errors

        print(
            json.dumps(
                {
                    "url": URL,
                    "workspace": str(workspace),
                    "queueDatabase": str(QUEUE_DATABASE),
                    "pageClosedWhileRunning": True,
                    "visibleQueueCountBeforeClose": visible_queue_count,
                    "completedWithoutOpenPages": [
                        {"id": row[0], "status": row[1], "runId": row[2]} for row in completed_rows
                    ],
                    "restoredResponses": [first_marker, second_marker],
                },
                indent=2,
            )
        )
        await browser.close()


asyncio.run(main())
