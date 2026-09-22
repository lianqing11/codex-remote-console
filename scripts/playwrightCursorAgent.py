import asyncio
import json
import os
import pathlib
import subprocess
import tempfile

from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""


async def wait_for_file(path: pathlib.Path, timeout_seconds: int = 120) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while asyncio.get_running_loop().time() < deadline:
        if path.exists():
            return
        await asyncio.sleep(0.5)
    raise AssertionError(f"Cursor Agent did not create {path.name} within {timeout_seconds}s.")


async def main() -> None:
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="coding-agent-console-real-cursor-"))
    subprocess.run(["git", "init", str(workspace)], check=True, capture_output=True, text=True)
    written_file = workspace / "cursor-agent-write.txt"

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 1000})
        page = await context.new_page()
        console_errors: list[str] = []
        failed_responses: list[str] = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on(
            "response",
            lambda response: failed_responses.append(f"{response.status} {response.url}")
            if response.status >= 500
            else None,
        )

        await page.goto(URL, wait_until="networkidle")
        password_input = page.locator('input[placeholder="Password or token"]')
        if await password_input.count():
            assert PASSWORD, "CODEX_WEB_PASSWORD or CODEX_WEB_TOKEN is required."
            await password_input.fill(PASSWORD)
            await page.get_by_role("button", name="Sign in").click()
        await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
        await page.evaluate(
            "([cwd]) => { localStorage.setItem('coding-agent-console.cwd', cwd); "
            "localStorage.setItem('coding-agent-console.recentDirs', JSON.stringify([cwd])); "
            "localStorage.setItem('coding-agent-console.provider', 'cursor'); }",
            [str(workspace)],
        )
        await page.reload(wait_until="networkidle")
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        await page.get_by_role("button", name="New session").click()
        await page.get_by_role("radio", name="Cursor").wait_for(state="visible", timeout=30_000)
        await page.get_by_text("Allowlist · no sandbox", exact=True).wait_for(state="visible", timeout=20_000)

        await page.locator("button.newSessionPrimary", has_text="New Cursor").click()
        await page.get_by_text("send a task to create the session", exact=False).wait_for(state="visible", timeout=10_000)
        await page.get_by_role("button", name="Agent", exact=True).click()
        await page.locator(".sessionModeSwitch button.active", has_text="Agent").wait_for(
            state="visible", timeout=30_000
        )

        composer = page.locator('textarea[placeholder^="Send a task to Cursor"]')
        await composer.fill(
            "Use the file editing tool to create cursor-agent-write.txt in this workspace containing exactly CURSOR_AGENT_WRITE_OK."
        )
        await page.locator("button.primaryButton", has_text="Send").click()
        await wait_for_file(written_file)
        assert written_file.read_text().strip() == "CURSOR_AGENT_WRITE_OK"
        await page.get_by_role("button", name="Stop").wait_for(state="hidden", timeout=120_000)
        await page.locator(".message.toolCall").last.wait_for(state="visible", timeout=30_000)
        assert await page.get_by_text("Sandbox mode is enabled but not available", exact=False).count() == 0

        await page.get_by_role("button", name="Changes", exact=True).click()
        changes_context = page.locator(".contextPane.context-diff")
        await changes_context.wait_for(state="visible", timeout=30_000)
        await changes_context.get_by_text("cursor-agent-write.txt", exact=False).first.wait_for(
            state="visible", timeout=30_000
        )
        await page.screenshot(path="/tmp/coding-agent-console-cursor-agent.png", full_page=True)

        assert not failed_responses, failed_responses
        assert not console_errors, console_errors
        print(
            json.dumps(
                {
                    "url": URL,
                    "workspace": str(workspace),
                    "modeSwitch": "Ask and Agent each created a new native Cursor session",
                    "executionMode": "--sandbox disabled --trust without --force",
                    "write": "cursor-agent-write.txt contains CURSOR_AGENT_WRITE_OK",
                    "diff": "cursor-agent-write.txt visible",
                    "screenshot": "/tmp/coding-agent-console-cursor-agent.png",
                },
                indent=2,
            )
        )
        await browser.close()


asyncio.run(main())
