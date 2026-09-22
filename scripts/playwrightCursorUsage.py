import asyncio
import json
import os
import re

from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""


async def main() -> None:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
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
        await page.evaluate("localStorage.setItem('coding-agent-console.provider', 'cursor')")
        await page.reload(wait_until="networkidle")
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)

        usage = page.locator(".cursorUsagePill")
        await usage.wait_for(state="visible", timeout=20_000)
        text = " ".join((await usage.inner_text()).split())
        title = await usage.get_attribute("title") or ""
        assert "Models" in text and "API" in text, text
        assert text.count("%") >= 2, text
        assert "Models" in title and "API" in title, title
        await page.screenshot(path="/tmp/coding-agent-console-cursor-usage.png", full_page=True)

        await page.set_viewport_size({"width": 390, "height": 844})
        await usage.wait_for(state="visible")
        mobile_text = " ".join((await usage.inner_text()).split())
        assert "Models" in mobile_text and "API" in mobile_text, mobile_text
        assert await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        await page.screenshot(path="/tmp/coding-agent-console-cursor-usage-mobile.png", full_page=True)
        assert not console_errors, console_errors

        print(json.dumps({
            "url": URL,
            "usage": text,
            "mobileUsage": mobile_text,
            "details": title,
            "screenshot": "/tmp/coding-agent-console-cursor-usage.png",
            "mobileScreenshot": "/tmp/coding-agent-console-cursor-usage-mobile.png",
        }, indent=2))
        await browser.close()


asyncio.run(main())
