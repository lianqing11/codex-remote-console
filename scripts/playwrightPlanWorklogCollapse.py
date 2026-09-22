import asyncio
import json
import os
import pathlib
import subprocess
import tempfile

from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:3035/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""


async def main() -> None:
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="coding-agent-console-plan-worklog-"))
    subprocess.run(["git", "init", str(workspace)], check=True, capture_output=True, text=True)
    prompt = (
        "Run pwd once to confirm the workspace, then create a concise two-step implementation plan "
        "for adding one README heading. Do not modify files and do not execute the plan. "
        "Return the plan as the final result."
    )

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 390, "height": 844})
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
        await page.locator(".statusPill.online").wait_for(state="attached", timeout=20_000)

        await page.evaluate(
            """([cwd]) => {
                localStorage.setItem('coding-agent-console.cwd', cwd);
                localStorage.setItem('coding-agent-console.recentDirs', JSON.stringify([cwd]));
                localStorage.setItem('coding-agent-console.provider', 'codex');
                localStorage.setItem('coding-agent-console.codex.runtime', JSON.stringify({
                    provider: 'codex', mode: 'plan', model: '', reasoningEffort: 'low',
                    serviceTier: null, approvalPolicy: null, sandboxMode: null
                }));
            }""",
            [str(workspace)],
        )
        await page.reload(wait_until="networkidle")
        await page.locator(".statusPill.online").wait_for(state="attached", timeout=20_000)
        mode_switch = page.locator(".sessionModeSwitch")
        await mode_switch.wait_for(state="visible")
        plan_mode = mode_switch.get_by_role("button", name="Plan", exact=True)
        if await plan_mode.get_attribute("aria-pressed") != "true":
            await plan_mode.click()
        assert await plan_mode.get_attribute("aria-pressed") == "true"

        await page.get_by_role("button", name="Sessions", exact=True).click()
        await page.get_by_role("button", name="New Codex", exact=True).click()
        composer = page.locator(".composer textarea")
        await composer.wait_for(state="visible")
        await composer.fill(prompt)
        await page.locator(".composer .primaryButton", has_text="Send").click()

        plan_result = page.locator('.turnFinalAnswer[aria-label="Plan result"] .message.plan').last
        await plan_result.wait_for(state="visible", timeout=180_000)
        panel = plan_result.locator("xpath=ancestor::details[contains(@class, 'turnPanel')]")
        worklog = panel.locator(":scope > .turnBody > details.turnWorkLog")
        await worklog.wait_for(state="visible")

        assert (await plan_result.locator(":scope > header > span").first.inner_text()).strip() == "Plan"
        assert await worklog.get_attribute("open") is None
        assert not await worklog.locator(".message.plan").count()
        assert await plan_result.count() == 1

        await worklog.locator(":scope > summary").click()
        assert await worklog.get_attribute("open") is not None
        await worklog.locator(":scope > summary").click()
        assert await worklog.get_attribute("open") is None

        layout = await page.evaluate(
            """() => ({
              viewportWidth: document.documentElement.clientWidth,
              rootScrollWidth: document.documentElement.scrollWidth,
              bodyScrollWidth: document.body.scrollWidth
            })"""
        )
        assert layout["rootScrollWidth"] <= layout["viewportWidth"], layout
        assert layout["bodyScrollWidth"] <= layout["viewportWidth"], layout
        assert not console_errors, console_errors
        assert not failed_responses, failed_responses

        selected_row = page.locator(".fleetSessionRow.selected").first
        thread_key = await selected_row.get_attribute("data-session-key") if await selected_row.count() else ""
        screenshot = "/tmp/coding-agent-console-plan-worklog-collapsed.png"
        await page.screenshot(path=screenshot, full_page=True)
        print(
            json.dumps(
                {
                    "url": URL,
                    "workspace": str(workspace),
                    "threadKey": thread_key,
                    "planWorkLogCollapsed": True,
                    "planResultVisible": True,
                    "planLabel": "Plan",
                    "manualToggle": "passed",
                    "layout": layout,
                    "consoleErrors": console_errors,
                    "http5xx": failed_responses,
                    "screenshot": screenshot,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
