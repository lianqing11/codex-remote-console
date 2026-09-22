import asyncio
import json
import os
import pathlib
import subprocess
import tempfile

from playwright.async_api import Locator, Page, async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""


async def first_visible(locator: Locator) -> Locator | None:
    for index in range(await locator.count()):
        candidate = locator.nth(index)
        if await candidate.is_visible():
            return candidate
    return None


async def open_sessions(page: Page) -> None:
    sidebar = page.locator(".sidebar.mobileOpen")
    if not await sidebar.count() or not await sidebar.is_visible():
        await page.get_by_role("button", name="Sessions", exact=True).click()
        await sidebar.wait_for(state="visible", timeout=10_000)


async def select_session(page: Page, session_key: str) -> Locator:
    await open_sessions(page)
    row = await first_visible(page.locator(f'.fleetSessionRow[data-session-key="{session_key}"]'))
    assert row, f"Session is not visible: {session_key}"
    await row.locator(".fleetSessionMain").click()
    await page.locator(f'.sessionExecutionControl[data-session-key="{session_key}"]').wait_for(
        state="visible", timeout=30_000
    )
    return row


async def selected_mode(page: Page) -> str:
    return str(
        await page.locator(".sessionExecutionControl").get_attribute("data-execution-mode")
        or ""
    )


async def main() -> None:
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="coding-agent-console-session-mode-"))
    subprocess.run(["git", "init", str(workspace)], check=True, capture_output=True, text=True)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 390, "height": 844})
        page = await context.new_page()
        console_errors: list[str] = []
        page_errors: list[str] = []
        failed_responses: list[str] = []
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
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
                localStorage.setItem('coding-agent-console.threadLayout', 'recent');
            }""",
            [str(workspace)],
        )
        await page.reload(wait_until="networkidle")
        await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
        await page.locator(".statusPill.online").wait_for(state="attached", timeout=20_000)

        shared_control = page.locator(".sessionExecutionControl")
        assert await shared_control.count() == 1
        plan_button = shared_control.get_by_role("button", name="Plan", exact=True)
        if await plan_button.get_attribute("aria-pressed") != "true":
            await plan_button.click()
        assert await plan_button.get_attribute("aria-pressed") == "true"

        await open_sessions(page)
        await page.get_by_role("button", name="New Codex", exact=True).click()
        composer = page.locator(".composer textarea")
        await composer.wait_for(state="visible", timeout=20_000)
        await composer.fill(
            "Create a concise two-step implementation plan for adding a README heading. "
            "Do not modify files. Finish with a concrete plan."
        )
        await page.locator(".composer .primaryButton", has_text="Send").click()

        active_plan = page.locator(
            '.sessionExecutionControl.phase-running[data-execution-mode="plan"]'
        )
        await active_plan.wait_for(state="visible", timeout=60_000)
        plan_session_key = await active_plan.get_attribute("data-session-key")
        assert plan_session_key
        assert await active_plan.locator(".sessionModeSwitch").count() == 0
        assert await active_plan.get_by_role("button", name="Agent", exact=True).count() == 0

        plan_result = page.locator('.turnFinalAnswer[aria-label="Plan result"] .message.plan').last
        await plan_result.wait_for(state="visible", timeout=180_000)
        await page.locator(
            f'.sessionExecutionControl.phase-idle[data-session-key="{plan_session_key}"][data-execution-mode="plan"]'
        ).wait_for(state="visible", timeout=30_000)
        await page.get_by_role("button", name="Execute plan", exact=True).wait_for(
            state="visible", timeout=20_000
        )

        # Create a second, Agent-mode Session in the same workspace.
        await open_sessions(page)
        await page.get_by_role("button", name="New Codex", exact=True).click()
        agent_button = page.locator(".sessionModeSwitch").get_by_role(
            "button", name="Agent", exact=True
        )
        await agent_button.click()
        assert await agent_button.get_attribute("aria-pressed") == "true"
        await composer.fill("Reply with exactly AGENT_SESSION_OK. Do not use tools.")
        await page.locator(".composer .primaryButton", has_text="Send").click()
        await page.get_by_text("AGENT_SESSION_OK", exact=True).last.wait_for(
            state="visible", timeout=180_000
        )
        await page.locator('.sessionExecutionControl.phase-idle[data-execution-mode="default"]').wait_for(
            state="visible", timeout=30_000
        )
        agent_session_key = await shared_control.get_attribute("data-session-key")
        assert agent_session_key and agent_session_key != plan_session_key

        await select_session(page, plan_session_key)
        assert await selected_mode(page) == "plan"
        await open_sessions(page)
        refresh = page.get_by_role("button", name="Refresh sessions")
        await refresh.click()
        await page.wait_for_timeout(1_500)
        refreshed_plan_row = await first_visible(
            page.locator(f'.fleetSessionRow[data-session-key="{plan_session_key}"]')
        )
        assert refreshed_plan_row
        assert await refreshed_plan_row.get_attribute("data-session-mode") == "plan"
        await refreshed_plan_row.locator(".fleetSessionMain").click()
        assert await selected_mode(page) == "plan"

        await select_session(page, agent_session_key)
        assert await selected_mode(page) == "default"
        await page.reload(wait_until="networkidle")
        await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
        await page.locator(".statusPill.online").wait_for(state="attached", timeout=20_000)
        await select_session(page, plan_session_key)
        assert await selected_mode(page) == "plan"

        layout = await page.evaluate(
            """() => ({
                viewportWidth: document.documentElement.clientWidth,
                rootScrollWidth: document.documentElement.scrollWidth,
                bodyScrollWidth: document.body.scrollWidth,
                modeIsFirstComposerRegion: document.querySelector('.composer')?.firstElementChild
                  ?.matches('.sessionExecutionControl') ?? false,
                modeBottom: document.querySelector('.sessionExecutionControl')?.getBoundingClientRect().bottom ?? 0,
                inputTop: document.querySelector('.composerInputRow')?.getBoundingClientRect().top ?? 0,
                sharedControls: document.querySelectorAll('.sessionExecutionControl').length,
                minControlHeight: Math.min(...[...document.querySelectorAll('.sessionExecutionControl button')]
                  .map((button) => button.getBoundingClientRect().height))
            })"""
        )
        assert layout["rootScrollWidth"] <= layout["viewportWidth"], layout
        assert layout["bodyScrollWidth"] <= layout["viewportWidth"], layout
        assert layout["modeIsFirstComposerRegion"], layout
        assert layout["modeBottom"] <= layout["inputTop"], layout
        assert layout["sharedControls"] == 1, layout
        assert layout["minControlHeight"] >= 44, layout

        screenshot = "/tmp/coding-agent-console-session-mode-mobile.png"
        await page.screenshot(path=screenshot, full_page=True)
        assert not failed_responses, failed_responses
        assert not console_errors, console_errors
        assert not page_errors, page_errors
        print(
            json.dumps(
                {
                    "url": URL,
                    "workspace": str(workspace),
                    "planSession": plan_session_key,
                    "agentSession": agent_session_key,
                    "layout": layout,
                    "screenshot": screenshot,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
