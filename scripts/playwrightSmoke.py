import asyncio
import json
import os

from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""
DEFAULT_CURSOR_MODEL = "cursor-grok-4.6-high-fast"


async def main() -> None:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 1000})
        await context.add_init_script(
            "localStorage.setItem('coding-agent-console.cursor.runtime', JSON.stringify({provider: 'cursor', mode: 'default', model: 'auto'}))"
        )
        await context.add_cookies(
            [
                {
                    "name": "codex_remote_console_session",
                    "value": "legacy-cookie-sentinel",
                    "url": "http://127.0.0.1:1818/codex_web/",
                }
            ]
        )
        page = await context.new_page()
        console_errors: list[str] = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

        await page.goto(URL, wait_until="networkidle")
        assert await page.title() == "Coding Agent Console"
        await page.evaluate(
            "localStorage.setItem('codex-remote-console.sentinel', 'preserve-me')"
        )

        password_input = page.locator('input[placeholder="Password or token"]')
        if await password_input.count():
            assert PASSWORD, "CODEX_WEB_PASSWORD or CODEX_WEB_TOKEN is required for the browser smoke."
            await password_input.fill(PASSWORD)
            await page.get_by_role("button", name="Sign in").click()
            await page.locator(".appShell").wait_for(state="visible", timeout=20_000)

        await page.evaluate(
            """([cwd]) => {
                localStorage.setItem('coding-agent-console.cwd', cwd);
                localStorage.setItem('coding-agent-console.recentDirs', JSON.stringify([cwd]));
            }""",
            [os.getcwd()],
        )
        await page.reload(wait_until="networkidle")

        await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        assert await page.locator("h1", has_text="Console").count()
        assert await page.evaluate(
            "localStorage.getItem('codex-remote-console.sentinel')"
        ) == "preserve-me"

        legacy_cookie = next(
            cookie
            for cookie in await context.cookies()
            if cookie["name"] == "codex_remote_console_session"
        )
        new_cookie = next(
            cookie
            for cookie in await context.cookies()
            if cookie["name"] == "coding_agent_console_session"
        )
        assert legacy_cookie["value"] == "legacy-cookie-sentinel"
        assert legacy_cookie["path"] == "/codex_web/"
        assert new_cookie["path"] == "/codex_web_cursor/"

        await page.get_by_role("button", name="New session", exact=True).click()
        provider_strip = page.locator(".providerStrip:visible")
        cursor_chip = provider_strip.get_by_role("radio", name="Cursor", exact=True)
        assert await cursor_chip.count() == 1
        assert not await cursor_chip.is_disabled()
        await cursor_chip.click()
        await page.locator(".brand", has_text="Cursor").wait_for(state="visible")
        await page.get_by_role("button", name="New Cursor", exact=True).wait_for(state="visible")
        assert await page.get_by_role("button", name=f"Model {DEFAULT_CURSOR_MODEL}").count() == 1
        stored_cursor_runtime = await page.evaluate(
            "JSON.parse(localStorage.getItem('coding-agent-console.cursor.runtime'))"
        )
        assert stored_cursor_runtime["model"] == DEFAULT_CURSOR_MODEL
        assert await page.get_by_role("button", name="Ask").count() == 1
        assert await page.get_by_text("Allowlist · no sandbox", exact=True).count() >= 1
        assert await page.get_by_text("Fast mode", exact=False).count() == 0

        await page.get_by_label("Provider details", exact=True).click()
        await page.get_by_role("heading", name="Provider").wait_for(state="visible")
        assert await page.get_by_text("2026.", exact=False).count() >= 1
        await page.get_by_role("button", name="Close").last.click()

        await provider_strip.get_by_role("radio", name="Codex", exact=True).click()
        await page.locator(".brand", has_text="Codex").wait_for(state="visible")
        await page.get_by_role("button", name="New Codex", exact=True).wait_for(state="visible")
        assert await page.get_by_role("button", name="Ask").count() == 0

        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        await page.wait_for_timeout(1_500)
        assert await page.locator(".statusPill.online").count() == 1
        assert await page.get_by_text("WebSocket is not connected.", exact=True).count() == 0

        new_keys = await page.evaluate(
            "Object.keys(localStorage).filter((key) => key.startsWith('coding-agent-console.'))"
        )
        assert new_keys
        await page.screenshot(path="/tmp/coding-agent-console-playwright.png", full_page=True)
        assert not console_errors, console_errors

        print(
            json.dumps(
                {
                    "url": URL,
                    "title": await page.title(),
                    "websocket": "online",
                    "providers": ["Codex", "Cursor"],
                    "cursorDefaultModel": DEFAULT_CURSOR_MODEL,
                    "cursorCapabilities": "Ask and no-sandbox allowlist warning visible; Codex-only Fast mode hidden",
                    "legacyLocalStorage": "preserved",
                    "cookieIsolation": "preserved",
                    "screenshot": "/tmp/coding-agent-console-playwright.png",
                },
                indent=2,
            )
        )
        await browser.close()


asyncio.run(main())
