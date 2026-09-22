import asyncio
import json
import os
from pathlib import Path

from playwright.async_api import async_playwright


URL = os.environ.get(
    "CODING_AGENT_CONSOLE_TEST_URL",
    "http://127.0.0.1:1818/codex_web_cursor/",
)
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""
ROOT = Path(__file__).resolve().parents[1]


async def main() -> None:
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
                assert PASSWORD, "CODEX_WEB_PASSWORD or CODEX_WEB_TOKEN is required for the upload browser test."
                await password_input.fill(PASSWORD)
                await page.get_by_role("button", name="Sign in").click()

            await page.locator(".appShell").wait_for(state="visible", timeout=20_000)
            await page.locator(".statusPill.online").wait_for(state="visible", timeout=20_000)
            attach_button = page.get_by_role("button", name="Attach files to agent")
            assert await attach_button.count() == 1
            assert not await attach_button.is_disabled()
            file_input = page.locator('.composer input[type="file"]')
            assert await file_input.get_attribute("accept") is None

            async with page.expect_response(lambda response: "/api/uploads?" in response.url and response.request.method == "POST") as readme_response_info:
                await file_input.set_input_files(str(ROOT / "README.md"))
            readme_response = await readme_response_info.value
            assert readme_response.status == 201

            readme_chip = page.locator(".attachmentChip", has_text="README.md")
            await readme_chip.wait_for(state="visible")
            assert "On server" in await readme_chip.inner_text()
            assert await readme_chip.locator(".attachmentFileIcon").count() == 1

            async with page.expect_response(lambda response: "/api/uploads?" in response.url and response.request.method == "POST") as image_response_info:
                await file_input.set_input_files(str(ROOT / "docs/images/login.png"))
            image_response = await image_response_info.value
            assert image_response.status == 201

            image_chip = page.locator(".attachmentChip", has_text="login.png")
            await image_chip.wait_for(state="visible")
            image = image_chip.locator("img")
            await image.wait_for(state="visible")
            assert await image.evaluate("element => element.complete && element.naturalWidth > 0")
            assert await page.locator(".attachmentChip").count() == 2
            await page.screenshot(path="/tmp/coding-agent-console-file-upload.png", full_page=True)

            for file_name in ["README.md", "login.png"]:
                async with page.expect_response(
                    lambda response: "/api/uploads/" in response.url and response.request.method == "DELETE"
                ) as delete_response_info:
                    await page.get_by_role("button", name=f"Remove {file_name}").click()
                delete_response = await delete_response_info.value
                assert delete_response.status == 200

            assert await page.locator(".attachmentChip").count() == 0
            assert not console_errors, console_errors
            assert not failed_responses, failed_responses
            print(json.dumps({
                "url": URL,
                "uploads": [
                    {"name": "README.md", "kind": "file", "status": 201},
                    {"name": "login.png", "kind": "image", "status": 201},
                ],
                "downloadPreview": "image loaded",
                "delete": "both uploads returned 200",
                "consoleErrors": console_errors,
                "failedResponses": failed_responses,
                "screenshot": "/tmp/coding-agent-console-file-upload.png",
            }, indent=2))
        finally:
            while await page.locator(".attachmentChip button").count():
                try:
                    await page.locator(".attachmentChip button").first.click(timeout=2_000)
                    await page.wait_for_timeout(100)
                except Exception:
                    break
            await browser.close()


asyncio.run(main())
