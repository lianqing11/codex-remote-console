import asyncio
import json
import os
import pathlib

from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""
PROJECT_PATH = os.environ.get("CODING_AGENT_CONSOLE_TEST_PROJECT") or str(
    pathlib.Path(__file__).resolve().parents[1]
)
PROJECT_PATH_SELECTOR = f'.threadGroupPath[title={json.dumps(PROJECT_PATH)}]'


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

        await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
        await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
        await page.locator(".threadGroup .fleetSessionRow").first.wait_for(state="visible", timeout=20_000)
        shared_execution = page.locator(".sessionExecutionControl")
        assert await shared_execution.count() == 1
        await shared_execution.wait_for(state="visible")
        assert await page.locator(".promptQueue").count() == 0
        assert await page.get_by_text("Runs without this page", exact=True).count() == 0
        code_surface_styles = await page.evaluate(
            """() => {
                const host = document.createElement('article');
                host.className = 'message agentMessage';
                host.style.position = 'fixed';
                host.style.left = '-10000px';
                host.innerHTML = `
                    <div class="markdownBody gfmMarkdown">
                        <p>Inline <code>const value = 1</code></p>
                        <blockquote>Quoted context</blockquote>
                        <pre class="markdownPre"><code class="language-typescript">const value = 1;</code></pre>
                    </div>`;
                document.body.append(host);
                const read = (selector) => {
                    const style = getComputedStyle(host.querySelector(selector));
                    return { backgroundColor: style.backgroundColor, color: style.color };
                };
                const result = {
                    inlineCode: read('.markdownBody p code'),
                    quote: read('.markdownBody blockquote'),
                    codeBlock: read('.markdownPre'),
                    codeText: read('.markdownPre > code'),
                    codeBlockMetrics: (() => {
                        const style = getComputedStyle(host.querySelector('.markdownPre'));
                        return {
                            borderTopWidth: style.borderTopWidth,
                            borderRadius: style.borderRadius,
                            paddingTop: style.paddingTop
                        };
                    })()
                };
                host.remove();
                const turnBody = document.createElement('div');
                turnBody.className = 'turnBody';
                turnBody.style.position = 'fixed';
                turnBody.style.left = '-10000px';
                turnBody.innerHTML = `
                    <details class="turnWorkLog" open>
                      <summary><span class="turnWorkLogTitle">Work log</span><span class="turnWorkLogCounts">2 updates</span></summary>
                      <div class="turnWorkLogBody">
                        <article class="message agentMessage commentaryMessage" data-message-phase="commentary"><header><span>Progress update</span></header><p>First update</p></article>
                        <article class="message agentMessage commentaryMessage" data-message-phase="commentary"><header><span>Progress update</span></header><p>Second update</p></article>
                      </div>
                    </details>
                    <section class="turnFinalAnswer">
                      <article class="message agentMessage finalAnswerMessage" data-message-phase="final"><header><span>Final answer</span></header><p>Done</p></article>
                    </section>`;
                document.body.append(turnBody);
                const secondReplyStyle = getComputedStyle(turnBody.querySelectorAll('.commentaryMessage')[1]);
                const finalAnswerStyle = getComputedStyle(turnBody.querySelector('.finalAnswerMessage'));
                result.replyDivider = {
                    borderTopWidth: secondReplyStyle.borderTopWidth,
                    paddingTop: secondReplyStyle.paddingTop
                };
                result.finalAnswer = {
                    borderLeftWidth: finalAnswerStyle.borderLeftWidth,
                    backgroundColor: finalAnswerStyle.backgroundColor
                };
                turnBody.remove();
                return result;
            }"""
        )
        assert code_surface_styles["inlineCode"]["backgroundColor"] == "rgb(245, 248, 246)", code_surface_styles
        assert code_surface_styles["quote"]["backgroundColor"] == "rgb(245, 248, 246)", code_surface_styles
        assert code_surface_styles["codeBlock"]["backgroundColor"] == "rgba(0, 0, 0, 0)", code_surface_styles
        assert code_surface_styles["codeText"]["backgroundColor"] == "rgb(245, 248, 246)", code_surface_styles
        assert code_surface_styles["codeText"]["color"] == "rgb(45, 56, 51)", code_surface_styles
        assert code_surface_styles["codeBlockMetrics"] == {
            "borderTopWidth": "0px",
            "borderRadius": "0px",
            "paddingTop": "0px",
        }, code_surface_styles
        assert code_surface_styles["replyDivider"] == {
            "borderTopWidth": "1px",
            "paddingTop": "8px",
        }, code_surface_styles
        assert code_surface_styles["finalAnswer"] == {
            "borderLeftWidth": "2px",
            "backgroundColor": "rgba(0, 0, 0, 0)",
        }, code_surface_styles
        fleet_count = await page.locator(".fleetSessionRow").count()
        assert fleet_count >= 10, fleet_count

        project_group = page.locator(
            f'.threadGroup:has({PROJECT_PATH_SELECTOR})'
        ).first
        await project_group.wait_for(state="visible")
        project_row = project_group.locator(".fleetSessionRow").first
        project_row_box = await project_row.bounding_box()
        assert project_row_box and 40 <= project_row_box["height"] <= 96, project_row_box
        title = project_row.locator(".fleetSessionTitleLine strong")
        title_font_size = await title.evaluate("element => parseFloat(getComputedStyle(element).fontSize)")
        assert 13 <= title_font_size <= 14.5, title_font_size
        assert await project_row.locator("time").inner_text()
        directory = project_group.locator(".threadGroupPath")
        directory_text = (await directory.inner_text()).strip()
        assert directory_text.startswith("/"), directory_text
        assert await directory.get_attribute("title") == directory_text
        directory_styles = await directory.evaluate(
            "element => ({ whiteSpace: getComputedStyle(element).whiteSpace, textOverflow: getComputedStyle(element).textOverflow })"
        )
        assert directory_styles["whiteSpace"] == "nowrap", directory_styles
        assert directory_styles["textOverflow"] == "ellipsis", directory_styles
        selected_project_title = (await title.inner_text()).strip()
        await project_row.locator(".fleetSessionMain").click()
        await page.locator(".topbarTitleText > strong", has_text=selected_project_title).wait_for(state="visible")
        await project_row.locator(".fleetRowMenu summary").click()
        pin_action = page.get_by_role("menuitem", name="Pin session")
        if await pin_action.count():
            await pin_action.click()
        if "pinned" not in ((await project_group.get_attribute("class")) or ""):
            await project_group.locator(".threadGroupPin").click()
        await page.locator(".threadGroup.pinned .fleetSessionRow").first.wait_for(state="visible")

        await page.get_by_role("button", name="Files", exact=True).click()
        await page.locator(".contextPane.context-files").wait_for(state="visible")
        assert await page.locator(".chatColumn").is_visible(), "wide layout must keep chat visible"
        resize_handle = page.locator(".contextResizeHandle")
        box = await resize_handle.bounding_box()
        assert box
        await page.mouse.move(box["x"] + 5, box["y"] + 120)
        await page.mouse.down()
        await page.mouse.move(box["x"] - 35, box["y"] + 120)
        await page.mouse.up()
        stored_width = await page.evaluate("localStorage.getItem('coding-agent-console.contextWidth.v1')")
        assert stored_width
        await page.screenshot(path="/tmp/coding-agent-console-responsive-desktop.png", full_page=True)

        await page.get_by_role("button", name="Runtime", exact=True).click()
        await page.locator(".runtimePanel").wait_for(state="visible")
        assert await page.get_by_text("Provider", exact=True).count() >= 1

        await page.set_viewport_size({"width": 1024, "height": 768})
        await page.get_by_role("button", name="Changes", exact=True).click()
        await page.locator(".contextPane.context-diff").wait_for(state="visible")
        assert not await page.locator(".chatColumn").is_visible(), "medium layout must show one workspace pane"
        await page.screenshot(path="/tmp/coding-agent-console-responsive-tablet.png", full_page=True)

        await page.set_viewport_size({"width": 390, "height": 844})
        await page.wait_for_timeout(300)
        assert await page.locator(".topbarMeta .sessionModeMeta").count() == 0
        assert await page.locator(".topbarMeta .sessionProviderMeta").count() == 0
        if await page.locator('.sessionExecutionControl.phase-idle').count():
            assert await page.locator(".topbarMeta .sessionState").count() == 0
        bottom = page.locator(".bottomTabBar")
        for label in ["Sessions", "Chat", "Files", "Changes"]:
            assert await bottom.get_by_text(label, exact=True).count() == 1
        # The pill belongs to the selected session's provider, which depends on
        # local session data, so assert whichever one is mounted.
        mobile_usage = page.locator(".codexUsagePill, .claudeUsagePill, .cursorUsagePill").first
        await mobile_usage.wait_for(state="visible")
        mobile_usage_text = " ".join((await mobile_usage.inner_text()).split())
        assert mobile_usage_text, mobile_usage_text
        if await page.locator(".codexUsagePill").count():
            # "remaining" is hidden below 761px: the word is implied by the
            # percentage and the header row is the scarcest space on a phone.
            assert "Codex" in mobile_usage_text and "Reset" in mobile_usage_text, mobile_usage_text
            assert "remaining" not in mobile_usage_text, mobile_usage_text
        await bottom.get_by_role("button", name="Sessions", exact=False).click()
        await page.locator(".sidebar.mobileOpen.mobilePanel-sessions").wait_for(state="visible")
        assert await page.locator(".sidebar.mobileOpen .projectPanel").is_visible()

        active_codex_row = page.locator(".sidebar.mobileOpen .agentFleet .fleetSessionRow.status-running").filter(
            has=page.locator(".fleetSessionProvider", has_text="Codex")
        ).first
        active_controls_verified = await active_codex_row.count() > 0
        if active_controls_verified:
            await active_codex_row.locator(".fleetSessionMain").click()
            await page.locator(".sidebar.mobileOpen").wait_for(state="detached")
            active_composer = page.locator(".composer")
            await active_composer.wait_for(state="visible")
            assert await page.locator(".sessionExecutionControl").count() == 1
            assert await page.locator(".sessionModeSwitch").count() == 0
            active_mode = await shared_execution.get_attribute("data-execution-mode")
            if active_mode == "plan":
                assert await shared_execution.get_by_role("button", name="Agent", exact=True).count() == 0
            active_buttons = {
                label: active_composer.get_by_role("button", name=label, exact=True)
                for label in ["Steer", "Stop", "Send"]
            }
            for label, button in active_buttons.items():
                await button.wait_for(state="visible")
                assert (await button.inner_text()).strip() == label, (label, await button.inner_text())
                button_box = await button.bounding_box()
                assert button_box and button_box["height"] >= 44 and button_box["width"] >= 64, (label, button_box)
                assert button_box["x"] >= 0 and button_box["x"] + button_box["width"] <= 391, (label, button_box)
                assert await button.evaluate("element => element.scrollWidth <= element.clientWidth + 1"), label
            active_textarea_box = await active_composer.locator("textarea").bounding_box()
            active_actions_box = await active_composer.locator(".composerActions").bounding_box()
            assert active_textarea_box and active_actions_box
            assert active_actions_box["y"] >= active_textarea_box["y"] + active_textarea_box["height"] - 1
            assert await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
            await page.screenshot(path="/tmp/coding-agent-console-mobile-active-controls.png", full_page=True)
            await bottom.get_by_role("button", name="Sessions", exact=False).click()
            await page.locator(".sidebar.mobileOpen.mobilePanel-sessions").wait_for(state="visible")

        mobile_row = page.locator(
            f'.sidebar.mobileOpen .threadGroup:has({PROJECT_PATH_SELECTOR}) .fleetSessionRow'
        ).first
        mobile_row_box = await mobile_row.bounding_box()
        assert mobile_row_box and 48 <= mobile_row_box["height"] < 72, mobile_row_box
        mobile_title_font_size = await mobile_row.locator(".fleetSessionTitleLine strong").evaluate(
            "element => parseFloat(getComputedStyle(element).fontSize)"
        )
        assert 13 <= mobile_title_font_size <= 14, mobile_title_font_size
        mobile_meta_font_size = await page.locator(".sidebar.mobileOpen .threadGroupPath").first.evaluate(
            "element => parseFloat(getComputedStyle(element).fontSize)"
        )
        assert mobile_meta_font_size <= 11.5, mobile_meta_font_size
        mobile_menu_box = await mobile_row.locator(".fleetRowMenu summary").bounding_box()
        assert mobile_menu_box and mobile_menu_box["width"] >= 40 and mobile_menu_box["height"] >= 40, mobile_menu_box
        assert await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
        await mobile_row.scroll_into_view_if_needed()
        await page.wait_for_timeout(150)
        await page.screenshot(path="/tmp/coding-agent-console-session-card-mobile.png", full_page=True)
        await mobile_row.screenshot(path="/tmp/coding-agent-console-session-card-mobile-detail.png")
        selected_mobile_title = (await mobile_row.locator(".fleetSessionTitleLine strong").inner_text()).strip()
        await mobile_row.locator(".fleetSessionMain").click()
        await page.wait_for_timeout(150)
        assert await page.locator(".sidebar.mobileOpen").count() == 0
        assert "workspace-chat" in (await page.locator(".workspace").get_attribute("class") or "")
        await page.locator(".composer").wait_for(state="visible")
        assert await page.locator(".sessionExecutionControl").count() == 1
        assert await page.locator('.composer button:has-text("Close")').count() == 0
        assert (await page.locator(".topbarTitleText > strong").inner_text()).strip() == selected_mobile_title
        session_stepper = page.locator(".mobileSessionStepper")
        assert await session_stepper.is_visible()
        session_stepper_buttons = session_stepper.locator("button")
        assert await session_stepper_buttons.count() == 2
        assert any([await session_stepper_buttons.nth(index).is_enabled() for index in range(2)])
        assert "/" in (await session_stepper.locator(".mobileSessionPosition").inner_text())
        composer_box = await page.locator(".composer").bounding_box()
        bottom_box = await bottom.bounding_box()
        assert composer_box and bottom_box
        composer_to_nav_gap = bottom_box["y"] - (composer_box["y"] + composer_box["height"])
        assert -1 <= composer_to_nav_gap <= 2, composer_to_nav_gap
        composer_padding_bottom = await page.locator(".composer").evaluate(
            "element => parseFloat(getComputedStyle(element).paddingBottom)"
        )
        assert composer_padding_bottom <= 8, composer_padding_bottom
        textarea_box = await page.locator(".composer textarea").bounding_box()
        assert textarea_box and textarea_box["height"] <= 66, textarea_box
        send_button = page.locator(".composerPrimaryActions .primaryButton")
        await send_button.wait_for(state="visible")
        assert (await send_button.inner_text()).strip() == "Send", await send_button.inner_text()
        primary_action_box = await send_button.bounding_box()
        assert primary_action_box
        assert primary_action_box["height"] >= 44 and primary_action_box["width"] >= 64, primary_action_box
        composer_actions_box = await page.locator(".composerActions").bounding_box()
        assert composer_actions_box
        assert composer_actions_box["y"] >= textarea_box["y"] + textarea_box["height"] - 1
        primary_action_to_nav_gap = bottom_box["y"] - (
            primary_action_box["y"] + primary_action_box["height"]
        )
        assert 0 <= primary_action_to_nav_gap <= 10, primary_action_to_nav_gap
        mobile_topbar_box = await page.locator(".topbar").bounding_box()
        assert mobile_topbar_box and mobile_topbar_box["height"] <= 140, mobile_topbar_box
        empty_heading = page.locator(".emptyState h2")
        if await empty_heading.count():
            empty_heading_font_size = await empty_heading.evaluate(
                "element => parseFloat(getComputedStyle(element).fontSize)"
            )
            assert empty_heading_font_size <= 20, empty_heading_font_size
        await page.screenshot(path="/tmp/coding-agent-console-responsive-mobile.png", full_page=True)
        composer_y_before_scroll = (await page.locator(".composer").bounding_box())["y"]
        await page.locator(".turnList").evaluate("element => element.scrollTo({ top: element.scrollHeight })")
        await page.wait_for_timeout(100)
        composer_y_after_scroll = (await page.locator(".composer").bounding_box())["y"]
        assert abs(composer_y_after_scroll - composer_y_before_scroll) <= 1

        for index in range(2):
            step_button = session_stepper_buttons.nth(index)
            if await step_button.is_enabled():
                await step_button.click()
                await page.wait_for_timeout(150)
                assert "workspace-chat" in (await page.locator(".workspace").get_attribute("class") or "")
                assert await page.locator(".sidebar.mobileOpen").count() == 0
                switched_composer_box = await page.locator(".composer").bounding_box()
                switched_bottom_box = await bottom.bounding_box()
                assert switched_composer_box and switched_bottom_box
                switched_composer_gap = switched_bottom_box["y"] - (
                    switched_composer_box["y"] + switched_composer_box["height"]
                )
                assert -1 <= switched_composer_gap <= 2, switched_composer_gap
                switched_primary_action_box = await page.locator(
                    ".composerPrimaryActions .primaryButton"
                ).bounding_box()
                assert switched_primary_action_box
                switched_primary_action_gap = switched_bottom_box["y"] - (
                    switched_primary_action_box["y"] + switched_primary_action_box["height"]
                )
                assert 0 <= switched_primary_action_gap <= 10, switched_primary_action_gap
                break
        await page.screenshot(path="/tmp/coding-agent-console-mobile-session-switch.png", full_page=True)

        # The session stepper can cross project roots. Re-select a repository-backed
        # session before exercising Files/Changes so the test does not ask the diff
        # API to treat the shared /projects directory as a Git worktree.
        await bottom.get_by_role("button", name="Sessions", exact=False).click()
        await page.locator(".sidebar.mobileOpen.mobilePanel-sessions").wait_for(state="visible")
        repo_mobile_row = page.locator(
            f'.sidebar.mobileOpen .threadGroup:has({PROJECT_PATH_SELECTOR}) .fleetSessionRow'
        ).first
        await repo_mobile_row.locator(".fleetSessionMain").click()
        await page.locator(".sidebar.mobileOpen").wait_for(state="detached")

        await bottom.get_by_role("button", name="Files", exact=True).click()
        await page.locator(".contextPane.context-files").wait_for(state="visible")
        mobile_file_row = page.locator(".projectTreeRow").first
        await mobile_file_row.wait_for(state="visible")
        mobile_file_row_box = await mobile_file_row.bounding_box()
        assert mobile_file_row_box and 44 <= mobile_file_row_box["height"] <= 60, mobile_file_row_box
        await page.screenshot(path="/tmp/coding-agent-console-files-mobile.png", full_page=True)

        await bottom.get_by_role("button", name="Changes", exact=False).click()
        await page.locator(".contextPane.context-diff").wait_for(state="visible")
        mobile_changes_heading = page.locator(".workspaceDiffHeader strong").first
        mobile_changes_heading_font_size = await mobile_changes_heading.evaluate(
            "element => parseFloat(getComputedStyle(element).fontSize)"
        )
        assert mobile_changes_heading_font_size <= 14, mobile_changes_heading_font_size
        assert await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
        await page.screenshot(path="/tmp/coding-agent-console-changes-mobile.png", full_page=True)

        assert not failed_responses, failed_responses
        assert not console_errors, console_errors
        print(
            json.dumps(
                {
                    "url": URL,
                    "fleetRows": fleet_count,
                    "wideContext": "chat + files visible",
                    "storedContextWidth": stored_width,
                    "tabletContext": "single pane",
                    "mobileNavigation": ["Sessions", "Chat", "Files", "Changes"],
                    "mobileUsage": mobile_usage_text,
                    "activeControlsVerified": active_controls_verified,
                    "screenshots": [
                        "/tmp/coding-agent-console-responsive-desktop.png",
                        "/tmp/coding-agent-console-responsive-tablet.png",
                        "/tmp/coding-agent-console-session-card-mobile.png",
                        "/tmp/coding-agent-console-session-card-mobile-detail.png",
                        "/tmp/coding-agent-console-mobile-active-controls.png" if active_controls_verified else None,
                        "/tmp/coding-agent-console-responsive-mobile.png",
                        "/tmp/coding-agent-console-mobile-session-switch.png",
                        "/tmp/coding-agent-console-files-mobile.png",
                        "/tmp/coding-agent-console-changes-mobile.png",
                    ],
                },
                indent=2,
            )
        )
        await browser.close()


asyncio.run(main())
