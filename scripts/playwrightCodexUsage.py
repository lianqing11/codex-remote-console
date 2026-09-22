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
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        usage = page.locator(".codexUsagePill")
        await usage.wait_for(state="visible", timeout=20_000)

        text = " ".join((await usage.inner_text()).split())
        title = await usage.get_attribute("title") or ""
        assert re.search(r"Codex \d+(?:\.\d+)?%", text), text
        assert re.search(r"Reset [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC", text), text
        assert "Standard Codex bucket" in title
        assert "% remaining" in title
        assert "% used" not in title
        assert re.search(r"resets \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC", title), title
        await page.screenshot(path="/tmp/coding-agent-console-codex-usage.png", full_page=True)

        await page.set_viewport_size({"width": 390, "height": 844})
        await usage.wait_for(state="visible")
        mobile_text = " ".join((await usage.inner_text()).split())
        assert "remaining" in mobile_text, mobile_text
        assert re.search(r"Reset [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC", mobile_text), mobile_text
        mobile_metrics = await usage.evaluate(
            """element => {
                const rect = element.getBoundingClientRect();
                const reset = element.querySelector('.codexUsageReset').getBoundingClientRect();
                return {
                    left: rect.left,
                    right: rect.right,
                    width: rect.width,
                    resetLeft: reset.left,
                    resetRight: reset.right,
                    scrollWidth: element.scrollWidth,
                    clientWidth: element.clientWidth,
                    viewportWidth: window.innerWidth
                };
            }"""
        )
        assert mobile_metrics["left"] >= 0, mobile_metrics
        assert mobile_metrics["right"] <= mobile_metrics["viewportWidth"] + 1, mobile_metrics
        assert mobile_metrics["resetLeft"] >= mobile_metrics["left"], mobile_metrics
        assert mobile_metrics["resetRight"] <= mobile_metrics["right"] + 1, mobile_metrics
        assert mobile_metrics["scrollWidth"] <= mobile_metrics["clientWidth"] + 1, mobile_metrics
        assert await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        await page.screenshot(path="/tmp/coding-agent-console-codex-usage-mobile.png", full_page=True)

        await page.set_viewport_size({"width": 320, "height": 700})
        await usage.wait_for(state="visible")
        narrow_metrics = await usage.evaluate(
            """element => {
                const rect = element.getBoundingClientRect();
                const reset = element.querySelector('.codexUsageReset').getBoundingClientRect();
                return {
                    left: rect.left,
                    right: rect.right,
                    resetLeft: reset.left,
                    resetRight: reset.right,
                    scrollWidth: element.scrollWidth,
                    clientWidth: element.clientWidth,
                    viewportWidth: window.innerWidth
                };
            }"""
        )
        assert narrow_metrics["left"] >= 0, narrow_metrics
        assert narrow_metrics["right"] <= narrow_metrics["viewportWidth"] + 1, narrow_metrics
        assert narrow_metrics["resetLeft"] >= narrow_metrics["left"], narrow_metrics
        assert narrow_metrics["resetRight"] <= narrow_metrics["right"] + 1, narrow_metrics
        assert narrow_metrics["scrollWidth"] <= narrow_metrics["clientWidth"] + 1, narrow_metrics
        assert await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        await page.screenshot(path="/tmp/coding-agent-console-codex-usage-narrow.png", full_page=True)
        assert not console_errors, console_errors

        print(json.dumps({
            "url": URL,
            "usage": text,
            "mobileUsage": mobile_text,
            "mobileMetrics": mobile_metrics,
            "narrowMetrics": narrow_metrics,
            "details": title,
            "screenshot": "/tmp/coding-agent-console-codex-usage.png",
            "mobileScreenshot": "/tmp/coding-agent-console-codex-usage-mobile.png",
            "narrowScreenshot": "/tmp/coding-agent-console-codex-usage-narrow.png",
        }, indent=2))
        await browser.close()


asyncio.run(main())
