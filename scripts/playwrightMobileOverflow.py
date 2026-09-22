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
        context = await browser.new_context(viewport={"width": 390, "height": 844})
        page = await context.new_page()
        console_errors: list[str] = []
        failed_responses: list[str] = []
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
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

        try:
            await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
        except Exception:
            await page.screenshot(path="/tmp/coding-agent-console-mobile-overflow-bootstrap-failed.png", full_page=True)
            raise AssertionError(
                json.dumps(
                    {
                        "url": page.url,
                        "title": await page.title(),
                        "body": (await page.locator("body").inner_text())[:1_500],
                        "consoleErrors": console_errors,
                        "failedResponses": failed_responses,
                        "screenshot": "/tmp/coding-agent-console-mobile-overflow-bootstrap-failed.png",
                    },
                    indent=2,
                )
            )
        await page.locator(".composer textarea").wait_for(state="visible", timeout=20_000)

        results: list[dict[str, object]] = []
        for width, height in [(390, 844), (320, 700)]:
            await page.set_viewport_size({"width": width, "height": height})
            await page.locator(".composer textarea").fill(
                "MOBILE_INPUT_START " + "unbroken_input_" * 180 + " MOBILE_INPUT_END"
            )
            await page.evaluate(
                """() => {
                    const secondaryActions = document.querySelector('.composerSecondaryActions');
                    const primaryActions = document.querySelector('.composerPrimaryActions');
                    if (secondaryActions && !secondaryActions.querySelector('[data-mobile-steer-fixture]')) {
                      const steer = document.createElement('button');
                      steer.type = 'button';
                      steer.dataset.mobileSteerFixture = 'true';
                      steer.textContent = 'Steer';
                      secondaryActions.append(steer);
                    }
                    if (primaryActions && !primaryActions.querySelector('[data-mobile-stop-fixture]')) {
                      const stop = document.createElement('button');
                      stop.type = 'button';
                      stop.className = 'dangerButton';
                      stop.dataset.mobileStopFixture = 'true';
                      stop.textContent = 'Stop';
                      primaryActions.prepend(stop);
                    }
                    document.querySelector('.turnList > .emptyState')?.remove();
                    document.querySelector('[data-mobile-overflow-fixture]')?.remove();
                    const fixture = document.createElement('details');
                    fixture.open = true;
                    fixture.className = 'turnPanel active';
                    fixture.dataset.mobileOverflowFixture = 'true';
                    fixture.innerHTML = `
                      <summary>
                        <span class="turnSummaryMain">
                          <strong>Long mobile content boundary check</strong>
                          <small>${'session-path-without-breaks/'.repeat(20)}</small>
                        </span>
                        <span class="turnSummaryMeta"><span>completed</span><span>12:34:56</span></span>
                      </summary>
                      <div class="turnBody">
                        <article class="message userMessage">
                          <header><span>You</span></header>
                          <pre>${'USER_OUTPUT_WITHOUT_BREAKS_'.repeat(90)}</pre>
                        </article>
                        <details class="turnWorkLog" open>
                          <summary>
                            <span class="turnWorkLogTitle"><strong>Work log with a deliberately long title</strong></span>
                            <span class="turnWorkLogCounts">18 updates · 12 actions · 8 reasoning</span>
                            <span class="turnWorkLogLive">Live</span>
                          </summary>
                          <div class="turnWorkLogBody">
                            <details class="message activityCard" open>
                              <summary><span>Command</span><code>${'/very/long/tool/path/'.repeat(25)}</code></summary>
                              <div class="activityBody"><pre>${'COMMAND_OUTPUT_'.repeat(140)}</pre></div>
                            </details>
                          </div>
                        </details>
                        <section class="turnFinalAnswer">
                          <article class="message agentMessage finalAnswerMessage">
                            <header><span>Final answer</span><small>Codex</small></header>
                            <div class="markdownBody gfmMarkdown">
                              <p>${'LONG_FINAL_TOKEN_'.repeat(150)}</p>
                              <pre class="markdownPre"><code>${'const_long_identifier_'.repeat(120)}</code></pre>
                              <div class="markdownTableWrap">
                                <table><tbody><tr><th>Field</th><td>${'table_value_'.repeat(120)}</td></tr></tbody></table>
                              </div>
                              <img alt="wide fixture" width="1600" height="80"
                                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1600' height='80'%3E%3Crect width='1600' height='80' fill='%23dcebe5'/%3E%3C/svg%3E" />
                            </div>
                          </article>
                        </section>
                      </div>`;
                    document.querySelector('.turnList')?.prepend(fixture);
                }"""
            )
            await page.wait_for_timeout(150)
            metrics = await page.evaluate(
                """() => {
                    const viewportWidth = document.documentElement.clientWidth;
                    const selectors = [
                      '.appShell',
                      '.workspace',
                      '.chatColumn',
                      '.turnList',
                      '[data-mobile-overflow-fixture]',
                      '[data-mobile-overflow-fixture] .turnBody',
                      '[data-mobile-overflow-fixture] .message',
                      '[data-mobile-overflow-fixture] .markdownBody',
                      '.composer',
                      '.sessionExecutionControl',
                      '.composerInputRow',
                      '.composerActions'
                    ];
                    const outside = [];
                    for (const selector of selectors) {
                      for (const element of document.querySelectorAll(selector)) {
                        const rect = element.getBoundingClientRect();
                        if (rect.left < -1 || rect.right > viewportWidth + 1) {
                          outside.push({ selector, left: rect.left, right: rect.right });
                        }
                      }
                    }
                    const actions = [...document.querySelectorAll('.composerActions button')].map((element) => {
                      const rect = element.getBoundingClientRect();
                      return {
                        label: element.textContent?.trim(),
                        left: rect.left,
                        right: rect.right,
                        height: rect.height,
                        scrollWidth: element.scrollWidth,
                        clientWidth: element.clientWidth
                      };
                    });
                    const textarea = document.querySelector('.composer textarea');
                    const composer = document.querySelector('.composer');
                    const modeControl = document.querySelector('.sessionExecutionControl');
                    const inputRow = document.querySelector('.composerInputRow');
                    const code = document.querySelector('[data-mobile-overflow-fixture] .markdownPre');
                    const table = document.querySelector('[data-mobile-overflow-fixture] .markdownTableWrap');
                    const image = document.querySelector('[data-mobile-overflow-fixture] .markdownBody img');
                    return {
                      viewportWidth,
                      rootScrollWidth: document.documentElement.scrollWidth,
                      bodyScrollWidth: document.body.scrollWidth,
                      outside,
                      actions,
                      modeIsFirstComposerRegion: composer?.firstElementChild
                        ?.matches('.sessionExecutionControl') ?? false,
                      modeBottom: modeControl?.getBoundingClientRect().bottom ?? 0,
                      inputTop: inputRow?.getBoundingClientRect().top ?? 0,
                      modeButtonHeights: modeControl
                        ? [...modeControl.querySelectorAll('button')].map((button) => button.getBoundingClientRect().height)
                        : [],
                      textarea: textarea ? {
                        scrollWidth: textarea.scrollWidth,
                        clientWidth: textarea.clientWidth,
                        height: textarea.getBoundingClientRect().height,
                        maxHeight: getComputedStyle(textarea).maxHeight
                      } : null,
                      code: code ? { scrollWidth: code.scrollWidth, clientWidth: code.clientWidth } : null,
                      table: table ? { scrollWidth: table.scrollWidth, clientWidth: table.clientWidth } : null,
                      image: image ? {
                        width: image.getBoundingClientRect().width,
                        parentWidth: image.parentElement?.getBoundingClientRect().width
                      } : null
                    };
                }"""
            )
            assert metrics["rootScrollWidth"] <= metrics["viewportWidth"], metrics
            assert metrics["bodyScrollWidth"] <= metrics["viewportWidth"], metrics
            assert not metrics["outside"], metrics
            assert metrics["modeIsFirstComposerRegion"], metrics
            assert metrics["modeBottom"] <= metrics["inputTop"], metrics
            assert metrics["modeButtonHeights"], metrics
            assert min(metrics["modeButtonHeights"]) >= 44, metrics
            assert metrics["textarea"], metrics
            assert metrics["textarea"]["scrollWidth"] <= metrics["textarea"]["clientWidth"] + 1, metrics
            assert metrics["textarea"]["height"] <= 181, metrics
            assert metrics["code"], metrics
            assert metrics["code"]["scrollWidth"] <= metrics["code"]["clientWidth"] + 1, metrics
            assert metrics["table"], metrics
            assert metrics["table"]["clientWidth"] <= metrics["viewportWidth"], metrics
            assert metrics["image"], metrics
            assert metrics["image"]["width"] <= metrics["image"]["parentWidth"] + 1, metrics
            assert all(action["height"] >= 44 for action in metrics["actions"]), metrics
            assert {action["label"] for action in metrics["actions"]} >= {"Image", "Steer", "Stop", "Send"}, metrics
            assert all(
                action["left"] >= 0 and action["right"] <= metrics["viewportWidth"] + 1
                for action in metrics["actions"]
            ), metrics
            screenshot = f"/tmp/coding-agent-console-mobile-overflow-{width}.png"
            await page.screenshot(path=screenshot, full_page=True)
            await page.locator(".composer textarea").fill("Short mobile follow-up")
            await page.locator(".turnList").evaluate("element => element.scrollTop = element.scrollHeight")
            await page.wait_for_timeout(100)
            output_screenshot = f"/tmp/coding-agent-console-mobile-output-{width}.png"
            await page.screenshot(path=output_screenshot, full_page=True)
            results.append(
                {
                    "viewport": [width, height],
                    "metrics": metrics,
                    "screenshots": [screenshot, output_screenshot],
                }
            )

        assert not failed_responses, failed_responses
        assert not console_errors, console_errors
        print(json.dumps({"url": URL, "results": results}, indent=2))
        await browser.close()


asyncio.run(main())
