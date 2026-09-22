import asyncio
import json
import os

from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""


async def main() -> None:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
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
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        paused_row = page.locator(".threadList .fleetSessionRow.status-paused").first
        queued_row = page.locator(".threadList .fleetSessionRow.status-queued").first
        row = paused_row if await paused_row.count() else queued_row
        await row.wait_for(state="visible", timeout=20_000)
        session_key = await row.get_attribute("data-session-key")
        assert session_key
        sidebar_state = (await row.locator(".fleetSessionState").inner_text()).strip()
        assert sidebar_state.startswith("Queue paused") or "queued" in sidebar_state.lower(), sidebar_state

        await row.locator(".fleetSessionMain").click()
        bar = page.locator(".queueStatusBar")
        await bar.wait_for(state="visible", timeout=30_000)
        assert await bar.get_by_role("button", name="Resume").count() == 0
        title = (await bar.locator(".queueStatusToggle strong").inner_text()).strip()
        assert title in {"Queue needs review", "Waiting for your input"} or title.endswith("queued"), title
        collapsed_box = await bar.bounding_box()
        assert collapsed_box and collapsed_box["height"] <= 64, collapsed_box

        await bar.locator(".queueStatusToggle").click()
        item_count = await bar.locator(".queueStatusItem").count()
        assert item_count >= 1
        assert await bar.locator(".queueItemState").count() == item_count
        await page.screenshot(path="/tmp/coding-agent-console-queue-paused-desktop.png", full_page=True)

        await page.set_viewport_size({"width": 390, "height": 844})
        await page.wait_for_timeout(150)
        assert await bar.is_visible()
        assert await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        await page.screenshot(path="/tmp/coding-agent-console-queue-paused-mobile.png", full_page=True)

        assert not failed_responses, failed_responses
        assert not console_errors, console_errors
        print(
            json.dumps(
                {
                    "url": URL,
                    "sessionKey": session_key,
                    "sidebarState": sidebar_state,
                    "queueItems": item_count,
                    "collapsedHeight": collapsed_box["height"],
                    "screenshots": [
                        "/tmp/coding-agent-console-queue-paused-desktop.png",
                        "/tmp/coding-agent-console-queue-paused-mobile.png",
                    ],
                },
                indent=2,
            )
        )
        await browser.close()


asyncio.run(main())
