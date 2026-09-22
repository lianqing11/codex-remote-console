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
        closed: dict[str, int] = {}
        for provider, label in (("codex", "Codex"), ("cursor", "Cursor")):
            provider_marker = page.locator(f'small[aria-label^="{label},"]')
            idle_row = page.locator(".threadList .fleetSessionRow.status-idle").filter(has=provider_marker).first
            await idle_row.wait_for(state="visible", timeout=20_000)
            session_key = await idle_row.get_attribute("data-session-key")
            assert session_key, f"Idle {label} session row did not expose its provider-aware key."

            matching_rows = page.locator(f'.fleetSessionRow[data-session-key="{session_key}"]')
            copies_before = await matching_rows.count()
            assert copies_before >= 1
            await idle_row.locator(".fleetRowMenu summary").click()
            await idle_row.get_by_role("menuitem", name="Close", exact=True).click()
            await matching_rows.wait_for(state="detached", timeout=10_000)
            await page.get_by_text("Session closed.", exact=True).wait_for(state="visible", timeout=10_000)

            await page.wait_for_timeout(1_000)
            assert await matching_rows.count() == 0, f"Closed {label} session reappeared in the list."
            closed[provider] = copies_before
        assert not failed_responses, failed_responses
        assert not console_errors, console_errors

        print(
            json.dumps(
                {
                    "url": URL,
                    "closedSessionCopies": closed,
                    "removedFromCurrentLists": True,
                    "stayedClosedAfterRefresh": True,
                },
                indent=2,
            )
        )
        await browser.close()


asyncio.run(main())
