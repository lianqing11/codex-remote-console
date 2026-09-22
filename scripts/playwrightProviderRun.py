import asyncio
import json
import os
import pathlib
import subprocess
import tempfile

from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""


async def main() -> None:
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="coding-agent-console-real-cursor-"))
    subprocess.run(["git", "init", str(workspace)], check=True, capture_output=True, text=True)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 1000})
        page = await context.new_page()
        console_errors: list[str] = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

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
            "localStorage.setItem('coding-agent-console.provider', 'codex'); }",
            [str(workspace)],
        )
        await page.reload(wait_until="networkidle")
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        await page.get_by_text(workspace.name, exact=False).first.wait_for(state="visible", timeout=20_000)

        await page.get_by_role("button", name="New session").click()
        await page.locator("button.newSessionPrimary", has_text="New Codex").click()
        await page.get_by_text("send a task to create the session", exact=False).wait_for(state="visible", timeout=10_000)

        codex_composer = page.locator('textarea[placeholder^="Send a task to Codex"]')
        await codex_composer.fill("Reply with exactly CODEX_UI_OK. Do not use tools or modify files.")
        await page.locator("button.primaryButton", has_text="Send").click()
        await page.locator(".topbarTitle strong").filter(has_not_text="No session selected").wait_for(
            state="visible", timeout=30_000
        )
        try:
            await page.locator(".message.agentMessage", has_text="CODEX_UI_OK").last.wait_for(
                state="visible", timeout=120_000
            )
        except PlaywrightTimeoutError:
            await page.screenshot(path="/tmp/coding-agent-console-provider-timeout.png", full_page=True)
            notice = await page.locator(".notice").all_text_contents()
            turns = await page.locator(".turnPanel").all_text_contents()
            raise AssertionError({"notice": notice, "turns": turns[-2:]})
        await page.get_by_role("button", name="Stop").wait_for(state="hidden", timeout=30_000)

        await page.get_by_role("button", name="New session").click()
        await page.get_by_role("radio", name="Cursor").click()
        await page.locator("button.newSessionPrimary", has_text="New Cursor").click()
        try:
            await page.locator("button.newSessionPrimary", has_text="New Cursor").wait_for(
                state="visible", timeout=90_000
            )
            await page.get_by_text("send a task to create the session", exact=False).wait_for(
                state="visible", timeout=10_000
            )
        except PlaywrightTimeoutError as error:
            notice = await page.locator(".notice").text_content() if await page.locator(".notice").count() else "no notice"
            raise AssertionError(f"Cursor provider switch failed: {notice}") from error
        assert await page.locator(".fleetSessionRow", has_text="Codex").count() >= 1

        await page.get_by_role("button", name="Ask").click()
        composer = page.locator('textarea[placeholder^="Send a task to Cursor"]')
        await composer.fill(
            "Explain in detail how to inspect a repository safely. This is a stop smoke; do not use tools."
        )
        await page.locator("button.primaryButton", has_text="Send").click()
        stop_button = page.get_by_role("button", name="Stop")
        await stop_button.wait_for(state="visible", timeout=20_000)
        assert await page.locator(".fleetSessionRow", has_text="Cursor").count() >= 1
        await stop_button.click()
        await stop_button.wait_for(state="hidden", timeout=30_000)

        await page.get_by_role("button", name="Agent", exact=True).click()
        await page.get_by_text("New empty Cursor Agent session created.", exact=False).wait_for(
            state="visible", timeout=90_000
        )
        await composer.fill(
            "Use a read-only glob tool to inspect this workspace. Then end your final response with exactly CURSOR_UI_OK."
        )
        await page.locator("button.primaryButton", has_text="Send").click()
        await page.locator(".message.toolCall").last.wait_for(state="visible", timeout=120_000)
        await page.locator(".message.agentMessage", has_text="CURSOR_UI_OK").last.wait_for(
            state="visible", timeout=120_000
        )
        await stop_button.wait_for(state="hidden", timeout=30_000)

        await page.reload(wait_until="networkidle")
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        workspace_group = page.locator(".threadGroup").filter(has_text=workspace.name)
        cursor_thread = workspace_group.locator(".fleetSessionRow").filter(has_text="Cursor").first
        await cursor_thread.wait_for(state="visible", timeout=20_000)
        await cursor_thread.click()
        await page.locator(".message.agentMessage", has_text="CURSOR_UI_OK").last.wait_for(
            state="visible", timeout=30_000
        )
        await page.locator(".message.toolCall").last.wait_for(state="visible", timeout=30_000)
        tool_cards = page.locator(".message.toolCall")
        tool_count = await tool_cards.count()
        assert tool_count >= 1
        assert await page.locator(".message.toolCall", has_text="Glob").count() >= 1
        assert await page.locator(".message.toolCall summary code", has_text="completed").count() == tool_count
        await page.get_by_text("completed", exact=True).first.wait_for(state="visible", timeout=30_000)

        await page.get_by_role("button", name="Changes", exact=True).click()
        assert await page.get_by_text("Cursor provider", exact=False).count() == 0
        await page.get_by_role("button", name="Chat", exact=True).click()

        await page.screenshot(path="/tmp/coding-agent-console-provider-run.png", full_page=True)
        assert not console_errors, console_errors
        print(
            json.dumps(
                {
                    "url": URL,
                    "workspace": str(workspace),
                    "codexRound": "CODEX_UI_OK completed",
                    "crossProviderSwitch": "new empty Cursor session created",
                    "cursorStop": "cancelled and Stop cleared",
                    "cursorAgent": "CURSOR_UI_OK tool activity streamed and restored after reload",
                    "cursorAgentWrite": "covered by the focused Cursor Agent write smoke",
                    "screenshot": "/tmp/coding-agent-console-provider-run.png",
                },
                indent=2,
            )
        )
        await browser.close()


asyncio.run(main())
