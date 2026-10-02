"""Deterministic UI/connection regression. Every API and provider frame is mocked.

Set CODING_AGENT_CONSOLE_FRONTEND_URL to inspect an isolated production build.
No agent tasks, uploads or real session mutations are sent.
"""
import json
import os
import pathlib
import time
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

URL = os.environ.get("CODING_AGENT_CONSOLE_TEST_URL", "http://127.0.0.1:1818/codex_web_cursor/")
FRONTEND = os.environ.get("CODING_AGENT_CONSOLE_FRONTEND_URL")
OUTPUT = pathlib.Path(os.environ.get("CODING_AGENT_CONSOLE_ARTIFACT_DIR", ".codex_web/ui-verification"))
OUTPUT.mkdir(parents=True, exist_ok=True)
ROOT = str(pathlib.Path.cwd())


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        errors, requests, sockets, delayed = [], [], [], []
        authenticated = [True]
        push_queue, reply_heartbeat, hold_next_resume = [True], [True], [False]
        held_resumes = []
        providers = {key: {"provider": key, "available": True, "authenticated": True, "status": "ready", "version": "fixture", "capabilities": {"models": True, "reasoningEffort": True, "planMode": True, "approvals": True, "serviceTier": True, "compact": True}} for key in ("codex", "cursor", "claude")}
        bootstrap = {"authenticated": True, "authEnabled": True, "wsHeartbeat": True, "codexVersion": "fixture", "defaultCwd": ROOT, "providers": providers, "codex": {"initializeInfo": {}, "collaborationModes": [], "pendingServerRequests": []}}

        def thread(key, title, count):
            return {"id": key, "provider": "codex", "cwd": ROOT, "name": title, "preview": title, "model": "fixture-model", "updatedAt": time.time(), "status": {"type": "idle"}, "turns": [{"id": f"{key}-{i}", "status": "completed", "items": [{"id": f"{key}-u{i}", "type": "userMessage", "content": [{"type": "text", "text": f"Unique user request {i}"}]}, {"id": f"{key}-a{i}", "type": "agentMessage", "phase": "final", "text": "Page review is ready.\n\n- Keep workspace details accessible.\n- Make the phone layout compact.\n\n```ts\nconst result = { ready: true };\n```\n\n| Task | Status |\n| --- | --- |\n| Layout | Ready |"}]} for i in range(count)]}
        fixtures = {"ui-a": thread("ui-a", "Interface and connection review", 45), "ui-b": thread("ui-b", "Second session", 1)}
        base = urlsplit(URL)

        def route_http(route):
            parsed = urlsplit(route.request.url)
            relative = parsed.path.removeprefix(base.path.rstrip("/"))
            if relative.startswith("/api/"):
                body = dict(bootstrap, authenticated=authenticated[0]) if relative == "/api/bootstrap" else {}
                if relative.startswith("/api/projects/resolve"):
                    body = {"cwd": ROOT, "realpath": ROOT, "readable": True, "writable": True, "git": {"insideWorkTree": True, "branch": "main", "root": ROOT}}
                elif relative.startswith("/api/projects/suggestions"): body = {"suggestions": []}
                elif relative == "/api/uploads":
                    body = {"id": "00000000-0000-4000-8000-000000000001", "name": "ui-fixture.txt", "size": 9, "contentType": "text/plain", "image": False, "createdAt": time.time()}
                route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
            elif FRONTEND and parsed.netloc == base.netloc and (relative in ("", "/") or relative.startswith("/_next/")):
                response = route.fetch(url=FRONTEND.rstrip("/") + (relative or "/") + ("?" + parsed.query if parsed.query else ""))
                route.fulfill(response=response)
            else: route.continue_()

        def reply(ws, message, result):
            ws.send(json.dumps({"type": "reply", "requestId": message["requestId"], "ok": True, "result": result}))

        def route_socket(ws):
            sockets.append(ws)
            pushed = [False]
            def receive(raw):
                message = json.loads(raw)
                method = message.get("method", "")
                requests.append({"method": method, "type": message["type"], "provider": message.get("provider"), "socket": len(sockets)})
                assert message["type"] in ("agent:request", "codex:request", "queue:list", "connection:ping"), message["type"]
                assert method not in ("turn/start", "thread/start", "thread/name/set", "thread/archive", "turn/interrupt"), method
                if not pushed[0] and push_queue[0]:
                    pushed[0] = True
                    ws.send(json.dumps({"type": "queue:snapshot", "snapshot": {"items": [], "threads": []}}))
                if message["type"] == "connection:ping" and not reply_heartbeat[0]: return
                if method == "thread/resume" and hold_next_resume[0]:
                    hold_next_resume[0] = False
                    held_resumes.append((ws, message))
                    return
                if method in ("thread/list", "session/list"):
                    if message.get("provider", "codex") != "codex" and len(sockets) == 1:
                        delayed.append((ws, message))
                        return
                    result = {"data": [dict(value, turns=[]) for value in fixtures.values()] if message.get("provider", "codex") == "codex" else [], "nextCursor": None}
                elif method in ("thread/read", "thread/resume"):
                    result = {"thread": fixtures[message["params"]["threadId"]], "model": "fixture-model", "reasoningEffort": "medium"}
                elif method.endswith("/list"): result = {"data": []}
                elif method == "account/rateLimits/read": result = {"rateLimits": None}
                else: result = {"items": [], "threads": []} if message["type"] == "queue:list" else {}
                reply(ws, message, result)
            ws.on_message(receive)

        page.route("**/*", route_http)
        page.route_web_socket("**/ws", route_socket)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script("""const NativeWS=window.WebSocket;window.WebSocket=class extends NativeWS{constructor(...args){super(...args);this.addEventListener('message',e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.message?.params?.delta==='FIRST_VISIBLE '){const t=performance.now();const check=()=>{if(document.querySelector('.turnPanel')?.innerText.includes('FIRST_VISIBLE'))window.firstDeltaPaintMs=performance.now()-t;else requestAnimationFrame(check)};requestAnimationFrame(check)}})}}""")
        started = time.monotonic()
        page.goto(URL + "?provider=codex&session=ui-a", wait_until="networkidle")
        page.locator(".turnPanel").first.wait_for(timeout=4000)
        independent_ms = round((time.monotonic() - started) * 1000)
        assert delayed, "slow-provider scenario was not exercised"
        assert page.locator(".turnPanel").count() == 40
        assert "Unique user request 44" in page.locator(".turnPanel").first.locator("summary").inner_text()
        assert page.locator(".turnPanel").first.locator(".userMessage").inner_text().count("Unique user request 44") == 1
        for ws, message in delayed: reply(ws, message, {"data": [], "nextCursor": None})
        page.wait_for_timeout(1100)
        assert not [r for r in requests if r["type"] == "queue:list"], "initial pushed snapshot was queried again"
        prompt = page.locator(".composer textarea")
        prompt.fill("Preserve this 中文 draft")
        prompt.press("Escape")
        assert prompt.input_value() == "Preserve this 中文 draft"
        prompt.evaluate("e=>{e.setSelectionRange(3,3);e.dispatchEvent(new Event('select',{bubbles:true}))}")
        page.locator('.composer input[type="file"]').set_input_files({"name": "ui-fixture.txt", "mimeType": "text/plain", "buffer": b"UI fixture"})
        page.locator(".attachmentChip").wait_for()

        page.get_by_role("button", name="Appearance", exact=True).click()
        dialog = page.get_by_role("dialog", name="Appearance")
        dialog.wait_for()
        assert dialog.evaluate("e=>e.contains(document.activeElement)")
        for mode in ("Light", "Dark"):
            dialog.get_by_role("button", name=mode, exact=True).click()
            for color in ("Green", "Blue", "Purple", "Amber"):
                dialog.get_by_role("button", name=color, exact=True).click()
                assert page.evaluate("document.documentElement.dataset.theme") == mode.lower()
                assert page.evaluate("document.documentElement.dataset.accent") == color.lower()
                assert prompt.input_value() == "Preserve this 中文 draft"
                page.keyboard.press("Escape")
                page.wait_for_timeout(180)
                page.screenshot(path=str(OUTPUT / f"theme-{mode.lower()}-{color.lower()}.png"))
                page.get_by_role("button", name="Appearance", exact=True).click()
                dialog = page.get_by_role("dialog", name="Appearance")
        page.emulate_media(color_scheme="dark")
        dialog.get_by_role("button", name="System", exact=True).click()
        assert page.evaluate("document.documentElement.dataset.theme") == "dark"
        page.emulate_media(color_scheme="light")
        page.wait_for_function("document.documentElement.dataset.theme === 'light'")
        dialog.get_by_role("button", name="Light", exact=True).click()
        dialog.get_by_role("button", name="Green", exact=True).click()
        page.keyboard.press("Escape")
        assert not page.get_by_role("dialog").count()
        assert page.get_by_role("button", name="Appearance", exact=True).evaluate("e=>e===document.activeElement")

        for width, height in ((1440, 1000), (1024, 768), (390, 844), (320, 700)):
            page.set_viewport_size({"width": width, "height": height})
            page.wait_for_timeout(100)
            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth"), width
            action = page.locator(".mobileToolsButton") if width <= 760 else page.get_by_role("button", name="Log out", exact=True)
            box = action.bounding_box()
            assert box and box["x"] >= 0 and box["x"] + box["width"] <= width + 1, (width, box)
            if width <= 760:
                assert page.locator('.sidebar').is_hidden(), "closed session sheet remained visible"
                assert prompt.is_visible(), "session sheet blocked the composer"
                assert page.locator(".bottomTabBar button:visible").count() == 3
                assert page.locator(".topbarMeta").is_visible()
                assert page.locator(".runtimeQuickButton").is_visible()
                assert page.locator(".sessionThinkingMeta").is_visible()
                assert "fixture-model" in page.locator(".runtimeQuickButton").inner_text()
                assert "Thinking medium" in page.locator(".sessionThinkingMeta").inner_text()
                assert page.evaluate("""() => [...document.querySelectorAll('.bottomTabBar button, .composerActions button')].filter(e=>e.getClientRects().length).every(e=>{const s=e.querySelector('svg');if(!s)return true;const a=e.getBoundingClientRect(),b=s.getBoundingClientRect();return Math.abs(a.x+a.width/2-b.x-b.width/2)<1 && Math.abs(a.y+a.height/2-b.y-b.height/2)<1})"""), "phone icons are off center"
                assert page.locator(".topbarTitleText").evaluate("e=>e.scrollLeft===0"), "title scrolled inside its clipped container"
                assert float(prompt.evaluate("e=>parseFloat(getComputedStyle(e).fontSize)")) >= 16
                page.locator(".mobileToolsButton").click()
                page.get_by_role("dialog", name="Tools").get_by_role("button", name="Appearance", exact=True).click()
                dialog = page.get_by_role("dialog", name="Appearance")
                dialog.get_by_role("button", name="Detailed", exact=True).click()
                page.keyboard.press("Escape")
                assert page.locator(".bottomTabBar button:visible").count() == 4
                assert prompt.input_value() == "Preserve this 中文 draft"
                page.locator(".mobileToolsButton").click()
                page.get_by_role("dialog", name="Tools").get_by_role("button", name="Appearance", exact=True).click()
                dialog.get_by_role("button", name="Minimal", exact=True).click()
                page.keyboard.press("Escape")
            page.screenshot(path=str(OUTPUT / f"viewport-{width}.png"))

        page.set_viewport_size({"width": 390, "height": 844})
        page.get_by_role("button", name="Sessions", exact=True).click()
        page.locator('a.fleetSessionMain[href*="session=ui-b"]').first.click()
        page.wait_for_timeout(150)
        assert not prompt.evaluate("e=>e===document.activeElement"), "switching a phone session focused the keyboard"
        assert prompt.input_value() == ""
        page.go_back()
        page.wait_for_timeout(150)
        assert prompt.input_value() == "Preserve this 中文 draft"
        assert prompt.evaluate("e=>e.selectionStart") == 3
        assert page.locator(".attachmentChip").count() == 1
        page.reload(wait_until="networkidle")
        page.locator(".turnPanel").first.wait_for()
        assert prompt.input_value() == "Preserve this 中文 draft"
        assert page.evaluate("document.documentElement.dataset.mobileLayout") == "minimal"

        # A-B-A-B, then an obsolete first B reply: the newest selection wins.
        hold_next_resume[0] = True
        def select_session(key):
            page.get_by_role("button", name="Sessions", exact=True).click()
            page.locator(f'a.fleetSessionMain[href*="session={key}"]').first.click()
            page.wait_for_timeout(120)
        select_session("ui-b")
        select_session("ui-a")
        select_session("ui-b")
        assert held_resumes
        ws, message = held_resumes.pop()
        reply(ws, message, {"thread": dict(fixtures["ui-b"], name="Obsolete selection"), "model": "wrong-model", "reasoningEffort": "low"})
        page.wait_for_timeout(150)
        assert "Second session" in page.locator(".topbarTitleText").inner_text()
        assert "Obsolete selection" not in page.locator(".topbar").inner_text()
        select_session("ui-a")

        def emit(method, params):
            sockets[-1].send(json.dumps({"type": "codex:notification", "message": {"method": method, "params": dict(params, threadId="ui-a")}}))
        emit("turn/started", {"turn": {"id": "stream", "status": "inProgress", "items": [], "startedAt": time.time()}})
        emit("item/started", {"turnId": "stream", "item": {"id": "stream-user", "type": "userMessage", "content": [{"type": "text", "text": "Streaming check"}]}})
        emit("item/started", {"turnId": "stream", "item": {"id": "stream-agent", "type": "agentMessage", "phase": "final", "text": ""}})
        emit("item/agentMessage/delta", {"turnId": "stream", "itemId": "stream-agent", "delta": "FIRST_VISIBLE "})
        page.wait_for_function("window.firstDeltaPaintMs !== undefined")
        first_paint = page.evaluate("window.firstDeltaPaintMs")
        assert first_paint <= 100, first_paint
        for i in range(12):
            emit("item/agentMessage/delta", {"turnId": "stream", "itemId": "stream-agent", "delta": f"word{i} "})
            page.wait_for_timeout(25)
        assert "word8" in page.locator(".turnPanel").first.inner_text()
        final = "FIRST_VISIBLE " + "".join(f"word{i} " for i in range(12))
        emit("item/completed", {"turnId": "stream", "item": {"id": "stream-agent", "type": "agentMessage", "phase": "final", "text": final}})
        emit("turn/completed", {"turn": {"id": "stream", "status": "completed", "items": [], "completedAt": time.time()}})
        page.wait_for_timeout(100)
        assert "word11" in page.locator(".turnPanel").first.inner_text()
        accepted = int(time.time() * 1000) - 1000
        item = {"id": "ui-status", "provider": "codex", "threadKey": "codex:ui-a", "threadId": "ui-a", "text": "Status demonstration", "cwd": ROOT, "threadParams": {}, "turnParams": {}, "runId": "status-run", "attempts": 1, "lastError": None, "baseTree": None, "diff": None, "createdAt": accepted / 1000, "updatedAt": time.time()}
        for status in ("queued", "running", "waiting_for_input", "failed"):
            item["status"] = status
            item["timings"] = {"acceptedAt": accepted, "startedAt": accepted + 200, **({"completedAt": int(time.time() * 1000)} if status == "failed" else {})}
            sockets[-1].send(json.dumps({"type": "queue:snapshot", "snapshot": {"items": [item], "threads": []}}))
            page.wait_for_timeout(100)
            assert page.locator(".runProgress").is_visible(), status
            if status == "failed":
                assert page.locator(".sessionExecutionControl").get_attribute("data-execution-phase") != "running"
            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth"), status
            page.screenshot(path=str(OUTPUT / f"state-{status}.png"))
        sockets[-1].send(json.dumps({"type": "queue:snapshot", "snapshot": {"items": [], "threads": []}}))
        socket_count = len(sockets)
        sockets[-1].close(code=1001, reason="Reconnect regression")
        page.wait_for_function("document.querySelector('.statusPill')?.textContent==='Online'")
        page.wait_for_timeout(1600)
        assert len(sockets) > socket_count
        assert prompt.input_value() == "Preserve this 中文 draft"
        before_ping = len([r for r in requests if r["type"] == "connection:ping"])
        page.evaluate("window.dispatchEvent(new Event('online'))")
        page.wait_for_timeout(100)
        assert len([r for r in requests if r["type"] == "connection:ping"]) == before_ping + 1
        reply_heartbeat[0] = False
        socket_count = len(sockets)
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        page.wait_for_timeout(5800)
        assert len(sockets) > socket_count, "an unanswered probe did not reconnect"
        reply_heartbeat[0] = True
        assert prompt.input_value() == "Preserve this 中文 draft"
        prompt.dispatch_event("keydown", {"key": "Enter", "ctrlKey": True, "isComposing": True})
        page.wait_for_timeout(50)
        assert prompt.input_value() == "Preserve this 中文 draft", "IME composition submitted the draft"
        authenticated[0] = False
        sockets[-1].close(code=1001, reason="Expired authentication")
        page.get_by_placeholder("Password or token").wait_for()
        assert page.evaluate("sessionStorage.getItem('coding-agent-console.sessionDrafts.v1')") is not None or page.evaluate("sessionStorage.length > 0")
        assert not errors, errors

        # A legacy backend does not receive pings; absent queue push queries once.
        authenticated[0] = True
        bootstrap["wsHeartbeat"] = False
        push_queue[0] = False
        legacy = browser.new_context(viewport={"width": 1024, "height": 768})
        legacy_page = legacy.new_page()
        legacy_page.route("**/*", route_http)
        legacy_page.route_web_socket("**/ws", route_socket)
        before = len(requests)
        legacy_page.goto(URL + "?provider=codex&session=ui-a", wait_until="networkidle")
        legacy_page.wait_for_timeout(1200)
        legacy_page.evaluate("window.dispatchEvent(new Event('online'))")
        legacy_page.wait_for_timeout(100)
        assert len([r for r in requests[before:] if r["type"] == "queue:list"]) == 1
        assert not [r for r in requests[before:] if r["type"] == "connection:ping"]
        legacy.close()
        push_queue[0] = True
        bootstrap["wsHeartbeat"] = True

        # A fresh context verifies initialization with completely unavailable storage.
        blocked = browser.new_context(viewport={"width": 390, "height": 844})
        blocked.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked storage')}})")
        blocked_page = blocked.new_page()
        blocked_errors = []
        blocked_page.on("pageerror", lambda error: blocked_errors.append(str(error)))
        authenticated[0] = True
        blocked_page.route("**/*", route_http)
        blocked_page.route_web_socket("**/ws", route_socket)
        blocked_page.goto(URL, wait_until="networkidle")
        blocked_page.locator(".composer textarea").fill("Storage-free editing")
        assert blocked_page.locator(".composer textarea").input_value() == "Storage-free editing"
        assert not blocked_errors, blocked_errors
        report = {"themes": "8 combinations and system changes passed", "viewports": [1440, 1024, 390, 320], "mobile": "minimal/detailed, navigation, no automatic keyboard passed", "independent_session_ready_ms": independent_ms, "first_delta_paint_ms": round(first_paint, 2), "initial_queue_queries": 0, "heartbeat": "probe, timeout reconnect, legacy capability and queue fallback passed", "late_selection_reply": "discarded", "reconnect_and_auth": "passed", "drafts_attachments_caret_ime_storage": "passed", "errors": errors}
        (OUTPUT / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
        browser.close()


if __name__ == "__main__":
    main()
