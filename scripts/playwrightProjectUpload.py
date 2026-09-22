import asyncio
import json
import os
import tempfile
from pathlib import Path

from playwright.async_api import async_playwright, expect


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="coding-agent-console-project-") as project_tmp, tempfile.TemporaryDirectory(
        prefix="coding-agent-console-project-upload-source-"
    ) as source_tmp:
        project = Path(project_tmp)
        source = Path(source_tmp)
        (project / "docs").mkdir()
        (project / "existing.txt").write_text("original\n", encoding="utf-8")
        (source / "new-file.txt").write_text("uploaded to root\n", encoding="utf-8")
        (source / "nested.md").write_text("# Nested upload\n", encoding="utf-8")
        (source / "existing.txt").write_text("replacement\n", encoding="utf-8")

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True, args=["--no-proxy-server"])
            context = await browser.new_context(viewport={"width": 1280, "height": 900})
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

            try:
                await page.goto(URL, wait_until="networkidle")
                password_input = page.locator('input[placeholder="Password or token"]')
                if await password_input.count():
                    assert PASSWORD, "CODEX_WEB_PASSWORD or CODEX_WEB_TOKEN is required for the project upload browser test."
                    await password_input.fill(PASSWORD)
                    await page.get_by_role("button", name="Sign in").click()

                await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
                await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
                assert await page.get_by_role("button", name="Attach files to agent").count() == 1

                await page.locator(".directorySummaryButton").click()
                picker = page.get_by_role("dialog", name="Choose server directory")
                await picker.wait_for(state="visible")
                path_input = picker.locator("#server-directory-path")
                await path_input.fill(str(project))
                await picker.get_by_role("button", name="Open path").click()
                await picker.locator(".directoryLocationHeader strong").filter(has_text=project.name).wait_for(state="visible")
                await picker.get_by_role("button", name="Use this directory").click()
                await picker.wait_for(state="detached")

                await page.locator(".workspaceTabs").get_by_role("button", name="Files", exact=True).click()
                workspace = page.locator(".projectFilesWorkspace")
                await workspace.wait_for(state="visible")
                project_upload_button = workspace.get_by_role("button", name="Upload files to project")
                assert await project_upload_button.count() == 1
                assert await project_upload_button.inner_text() == "Upload here"
                project_input = workspace.locator('.projectTreePane input[type="file"]')

                async with page.expect_response(
                    lambda response: "/api/projects/upload?" in response.url and response.request.method == "POST"
                ) as root_upload_info:
                    await project_input.set_input_files(str(source / "new-file.txt"))
                root_upload = await root_upload_info.value
                assert root_upload.status == 201
                await workspace.locator(".projectTreeRow", has_text="new-file.txt").wait_for(state="visible")
                assert (project / "new-file.txt").read_text(encoding="utf-8") == "uploaded to root\n"
                await expect(workspace.locator(".projectUploadStatus")).to_contain_text("Uploaded 1 file to project root.")

                await workspace.locator(".projectTreeRow.directory", has_text="docs").click()
                await workspace.locator(".projectBreadcrumbs").get_by_role("button", name="docs", exact=True).wait_for(state="visible")
                assert not await workspace.get_by_role("button", name="Upload files to project").is_disabled()
                async with page.expect_response(
                    lambda response: "/api/projects/upload?" in response.url and response.request.method == "POST"
                ) as nested_upload_info:
                    await project_input.set_input_files(str(source / "nested.md"))
                nested_upload = await nested_upload_info.value
                assert nested_upload.status == 201
                assert (project / "docs" / "nested.md").read_text(encoding="utf-8") == "# Nested upload\n"
                await expect(workspace.locator(".projectUploadStatus")).to_contain_text("Uploaded 1 file to docs.")

                await workspace.locator(".projectBreadcrumbs").get_by_role("button", name="root", exact=True).click()
                await project_input.set_input_files(str(source / "existing.txt"))
                assert (project / "existing.txt").read_text(encoding="utf-8") == "original\n"

                conflict_dialog = page.get_by_role("dialog", name="Replace existing files?")
                await conflict_dialog.wait_for(state="visible")
                assert "existing.txt" in await conflict_dialog.inner_text()
                await page.screenshot(path="/tmp/coding-agent-console-project-upload-conflict.png", full_page=True)
                async with page.expect_response(
                    lambda response: "/api/projects/upload?" in response.url and response.request.method == "POST"
                ) as replace_info:
                    await conflict_dialog.get_by_role("button", name="Replace 1 file", exact=True).click()
                replace = await replace_info.value
                assert replace.status == 200
                await conflict_dialog.wait_for(state="detached")
                assert (project / "existing.txt").read_text(encoding="utf-8") == "replacement\n"
                await page.screenshot(path="/tmp/coding-agent-console-project-upload.png", full_page=True)

                await page.reload(wait_until="networkidle")
                await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
                await page.locator(".workspaceTabs").get_by_role("button", name="Files", exact=True).click()
                await page.locator(".projectTreeRow", has_text="new-file.txt").wait_for(state="visible")

                assert not failed_responses, failed_responses
                assert not console_errors, console_errors
                print(
                    json.dumps(
                        {
                            "url": URL,
                            "project": str(project),
                            "newFile": {"path": "new-file.txt", "status": 201},
                            "nestedFile": {"path": "docs/nested.md", "status": 201},
                            "conflict": {"preflight": "confirmation shown before write", "replacementStatus": 200},
                            "persistence": "file remained visible after reload",
                            "agentAttachButton": "present separately",
                            "consoleErrors": console_errors,
                            "failedResponses": failed_responses,
                            "screenshot": "/tmp/coding-agent-console-project-upload.png",
                            "conflictScreenshot": "/tmp/coding-agent-console-project-upload-conflict.png",
                        },
                        indent=2,
                    )
                )
            finally:
                await browser.close()


asyncio.run(main())
