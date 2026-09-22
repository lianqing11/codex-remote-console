import asyncio
import json
import os
import pathlib
import subprocess
import tempfile
import time

from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""


async def main() -> None:
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="coding-agent-console-plan-confirm-"))
    subprocess.run(["git", "init", str(workspace)], check=True, capture_output=True, text=True)
    prompt = (
        "Before doing anything else, use request_user_input to ask one short question. "
        "Use header Smoke and offer Continue (Recommended) and Cancel. "
        "After I confirm Continue, reply with exactly PLAN_CONFIRM_OK. "
        "Do not use any other tools and do not modify files."
    )

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1280, "height": 900})
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
            """([cwd]) => {
                localStorage.setItem('coding-agent-console.cwd', cwd);
                localStorage.setItem('coding-agent-console.recentDirs', JSON.stringify([cwd]));
                localStorage.setItem('coding-agent-console.provider', 'codex');
                localStorage.setItem('coding-agent-console.runtime.codex', JSON.stringify({
                    provider: 'codex', mode: 'plan', model: '', reasoningEffort: 'low',
                    serviceTier: 'fast', approvalPolicy: null, sandboxMode: null
                }));
            }""",
            [str(workspace)],
        )
        await page.reload(wait_until="networkidle")
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        plan_button = page.locator(".sessionModeSwitch button", has_text="Plan")
        if "active" not in ((await plan_button.get_attribute("class")) or ""):
            await plan_button.click()
        await page.locator(".sessionModeSwitch button.active", has_text="Plan").wait_for(state="visible", timeout=20_000)
        await page.get_by_role("button", name="New session", exact=True).click()
        await page.get_by_role("button", name="New Codex", exact=True).click()
        await page.get_by_text("send a task to create the session", exact=False).wait_for(state="visible", timeout=10_000)

        composer = page.locator('textarea[placeholder^="Send a task to Codex"]')
        await composer.fill(prompt)
        await page.locator(".composer .primaryButton", has_text="Send").click()

        dialog = page.locator(".userInputDialog")
        await dialog.wait_for(state="visible", timeout=180_000)
        await dialog.locator(".option", has_text="Continue").click()
        assert await dialog.locator(".option input:checked").count() == 1
        await page.screenshot(path="/tmp/coding-agent-console-plan-confirm-before.png", full_page=True)

        confirm_started = time.monotonic()
        busy_feedback = await page.evaluate(
            """() => new Promise((resolve) => {
                const button = [...document.querySelectorAll('.userInputDialog .primaryButton')]
                    .find((element) => element.textContent?.includes('Confirm'));
                if (!button) return resolve({ sawBusy: false, error: 'Confirm button missing' });
                const started = performance.now();
                let settled = false;
                const finish = (payload) => {
                    if (settled) return;
                    settled = true;
                    observer.disconnect();
                    resolve(payload);
                };
                const check = () => {
                    const active = document.querySelector('.userInputDialog .primaryButton');
                    if (!document.querySelector('.userInputDialog')) {
                        finish({ sawBusy: true, feedback: 'dialog-closed', feedbackMs: performance.now() - started });
                    } else if (active?.disabled || active?.textContent?.includes('Continuing')) {
                        finish({ sawBusy: true, feedback: 'continuing', feedbackMs: performance.now() - started });
                    }
                };
                const observer = new MutationObserver(check);
                observer.observe(document.body, {
                    attributes: true, childList: true, subtree: true, characterData: true
                });
                button.click();
                check();
                setTimeout(() => {
                    finish({ sawBusy: false, feedbackMs: performance.now() - started });
                }, 2000);
            })"""
        )
        assert busy_feedback["sawBusy"], busy_feedback
        await dialog.wait_for(state="hidden", timeout=20_000)
        confirm_round_trip_ms = (time.monotonic() - confirm_started) * 1000
        await page.locator(".message.agentMessage", has_text="PLAN_CONFIRM_OK").last.wait_for(
            state="visible", timeout=180_000
        )
        await page.screenshot(path="/tmp/coding-agent-console-plan-confirm-after.png", full_page=True)

        assert not failed_responses, failed_responses
        assert not console_errors, console_errors
        print(
            json.dumps(
                {
                    "url": URL,
                    "workspace": str(workspace),
                    "busyFeedback": busy_feedback,
                    "dialogRoundTripMs": round(confirm_round_trip_ms, 1),
                    "result": "PLAN_CONFIRM_OK",
                    "screenshots": [
                        "/tmp/coding-agent-console-plan-confirm-before.png",
                        "/tmp/coding-agent-console-plan-confirm-after.png",
                    ],
                },
                indent=2,
            )
        )
        await browser.close()


asyncio.run(main())
