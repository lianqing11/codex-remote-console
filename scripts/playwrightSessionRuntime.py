import asyncio
import json
import os

from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""
THREAD_KEY = os.environ.get("CODING_AGENT_CONSOLE_TEST_THREAD_KEY", "")
EXPECTED_STATE = os.environ.get("CODING_AGENT_CONSOLE_EXPECTED_STATE", "")


async def main() -> None:
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

        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        if THREAD_KEY:
            row = page.locator(f'.fleetSessionRow[data-session-key="{THREAD_KEY}"]').first
        else:
            row = page.locator('.fleetSessionRow[data-session-key^="codex:"]').filter(
                has=page.locator(".fleetSessionModel")
            ).first
        await row.wait_for(state="visible", timeout=20_000)

        row_model = (await row.locator(".fleetSessionModel").inner_text()).strip()
        row_thinking = (await row.locator(".fleetSessionThinking").get_attribute("data-thinking-effort") or "").strip()
        row_speed = (await row.locator(".fleetSessionFast").inner_text()).strip()
        row_state = (await row.locator(".fleetSessionState").inner_text()).strip()
        assert row_model
        assert row_thinking
        assert row_speed in {"Fast", "Standard"}, row_speed
        if EXPECTED_STATE:
            row_classes = await row.get_attribute("class") or ""
            if EXPECTED_STATE == "Not Running":
                assert row_state != "Running", row_state
                assert "status-running" not in row_classes, row_classes
            else:
                assert row_state == EXPECTED_STATE, {"actual": row_state, "expected": EXPECTED_STATE}
                assert ("status-running" in row_classes) == (EXPECTED_STATE == "Running")

        await page.wait_for_timeout(500)
        if EXPECTED_STATE == "Not Running":
            refreshed_state = (await row.locator(".fleetSessionState").inner_text()).strip()
            assert refreshed_state != "Running", refreshed_state
            assert "status-running" not in (await row.get_attribute("class") or "")

        await row.locator(".fleetSessionMain").click()
        await page.locator(".topbarMeta").wait_for(state="visible")
        topbar_text = " ".join((await page.locator(".topbarMeta").inner_text()).split())
        assert row_model in topbar_text, topbar_text
        assert f"Thinking {row_thinking}" in topbar_text, topbar_text
        assert ("Fast mode" if row_speed == "Fast" else "Standard mode") in topbar_text, topbar_text
        if EXPECTED_STATE in {"Idle", "Not Running"}:
            assert await page.get_by_role("button", name="Stop", exact=True).count() == 0

        await page.screenshot(path="/tmp/coding-agent-console-session-runtime.png", full_page=True)
        assert not console_errors, console_errors
        assert not failed_responses, failed_responses
        print(json.dumps({
            "url": URL,
            "threadKey": await row.get_attribute("data-session-key"),
            "state": row_state,
            "model": row_model,
            "thinking": row_thinking,
            "speed": row_speed,
            "topbar": topbar_text,
            "screenshot": "/tmp/coding-agent-console-session-runtime.png",
        }, ensure_ascii=False, indent=2))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
