"""Keyboard geometry regression; native iOS keyboard still needs device QA.

Set CODEX_WEB_PASSWORD and optionally CODING_AGENT_CONSOLE_TEST_URL.
CODING_AGENT_CONSOLE_FRONTEND_URL can test an isolated Next build against the
existing API/WebSocket backend before publishing it.
"""
import json
import os
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


URL = os.environ.get("CODING_AGENT_CONSOLE_TEST_URL", "http://127.0.0.1:1818/codex_web_cursor/")
FRONTEND = os.environ.get("CODING_AGENT_CONSOLE_FRONTEND_URL")
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN", "")

# Desktop engines do not open a native phone keyboard. Inject only its viewport
# signals so the production listener and CSS can be exercised together.
VIEWPORT = """(() => {
  const viewport = window.visualViewport;
  let height = null, top = 0, scale = 1;
  Object.defineProperties(viewport, {
    height: {get: () => height ?? window.innerHeight},
    offsetTop: {get: () => top},
    scale: {get: () => scale}
  });
  window.setKeyboardViewport = (h, t = 0, s = 1) => {
    height = h; top = t; scale = s;
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
  };
})();"""


def metrics(page):
    return page.evaluate("""() => {
      const box = s => {
        const r = document.querySelector(s).getBoundingClientRect();
        return {top:r.top, bottom:r.bottom, height:r.height};
      };
      return {
        keyboard: document.documentElement.dataset.keyboardOpen === 'true',
        nav: getComputedStyle(document.querySelector('.bottomTabBar')).display,
        font: getComputedStyle(document.querySelector('.composer textarea')).fontSize,
        width: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        shell: box('.appShell'), input: box('.composer textarea'),
        actions: box('.composerActions')
      };
    }""")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(**p.devices["iPhone 13"])
        context.add_init_script(VIEWPORT)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        if FRONTEND:
            base = urlsplit(URL)

            def frontend_route(route):
                parsed = urlsplit(route.request.url)
                relative = parsed.path.removeprefix(base.path.rstrip("/"))
                if parsed.netloc == base.netloc and (relative in ("", "/") or relative.startswith("/_next/")):
                    response = route.fetch(url=FRONTEND.rstrip("/") + (relative or "/") + ("?" + parsed.query if parsed.query else ""))
                    route.fulfill(response=response)
                else:
                    route.continue_()

            page.route("**/*", frontend_route)
        page.goto(URL, wait_until="networkidle")
        login = page.locator('input[placeholder="Password or token"]')
        if login.count():
            assert PASSWORD, "Set CODEX_WEB_PASSWORD or CODEX_WEB_TOKEN"
            login.fill(PASSWORD)
            page.get_by_role("button", name="Sign in", exact=True).click()
        page.locator(".appShell").wait_for(timeout=20000)
        page.locator(".statusPill.online").wait_for(state="attached", timeout=20000)
        prompt = page.locator(".composer textarea")
        results = []
        for width, height, keyboard_height in [(390, 844, 360), (320, 700, 310), (844, 390, 220)]:
            page.set_viewport_size({"width": width, "height": height})
            page.evaluate("setKeyboardViewport(null)")
            page.wait_for_timeout(150)
            initial = metrics(page)
            assert float(initial["font"].removesuffix("px")) >= 16, initial
            assert initial["width"] <= width, initial
            prompt.focus()
            page.evaluate("setKeyboardViewport(innerHeight / 2, 0, 2)")
            page.wait_for_timeout(100)
            assert not metrics(page)["keyboard"], "Pinch zoom mistaken for keyboard"
            for _ in range(2):
                page.evaluate("setKeyboardViewport(null)")
                prompt.fill("手机输入测试\n第二行\n第三行\n第四行\n第五行\n第六行")
                page.evaluate("h => setKeyboardViewport(h, 12)", keyboard_height)
                page.wait_for_timeout(150)
                opened = metrics(page)
                assert opened["keyboard"] and opened["nav"] == "none", opened
                assert abs(opened["shell"]["height"] - keyboard_height) < 1, opened
                assert opened["input"]["top"] >= opened["shell"]["top"], opened
                assert opened["actions"]["bottom"] <= opened["shell"]["bottom"] + 1, opened
                assert opened["width"] <= width, opened
                # Closing via the native Done button need not blur the input.
                page.evaluate("setKeyboardViewport(null)")
                page.wait_for_timeout(150)
                closed = metrics(page)
                assert not closed["keyboard"], closed
                assert abs(closed["shell"]["height"] - height) < 1, closed
                assert closed["nav"] == initial["nav"], closed
            results.append({"size": [width, height], "open": opened, "closed": closed})
        prompt.fill("")
        prompt.blur()
        # Hardware keyboard / desktop focus must retain the original layout.
        page.set_viewport_size({"width": 1440, "height": 1000})
        prompt.focus()
        page.evaluate("setKeyboardViewport(600)")
        page.wait_for_timeout(150)
        assert not metrics(page)["keyboard"]
        assert not errors, errors
        print(json.dumps({"passed": True, "cases": results, "pageErrors": errors}, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
