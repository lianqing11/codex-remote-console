"""Exercise the real UI with deterministic provider events; never start an agent.

CODEX_WEB_PASSWORD/TOKEN authenticates the existing service. An optional
CODING_AGENT_CONSOLE_FRONTEND_URL selects a candidate build for UI verification.
"""
import json
import os
import time
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

URL = os.environ.get('CODING_AGENT_CONSOLE_TEST_URL', 'http://127.0.0.1:1818/codex_web_cursor/')
FRONTEND = os.environ.get('CODING_AGENT_CONSOLE_FRONTEND_URL')
PASSWORD = os.environ.get('CODEX_WEB_PASSWORD') or os.environ.get('CODEX_WEB_TOKEN', '')


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script('localStorage.setItem("coding-agent-console.cwd", ' + json.dumps(os.getcwd()) + ')')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        base = urlsplit(URL)
        if FRONTEND:
            def route_frontend(route):
                parsed = urlsplit(route.request.url)
                relative = parsed.path.removeprefix(base.path.rstrip('/'))
                if parsed.netloc == base.netloc and (relative in ('', '/') or relative.startswith('/_next/')):
                    response = route.fetch(url=FRONTEND.rstrip('/') + (relative or '/') + ('?' + parsed.query if parsed.query else ''))
                    route.fulfill(response=response)
                else:
                    route.continue_()
            page.route('**/*', route_frontend)

        def thread(key, count):
            return {'id': key, 'provider': 'codex', 'cwd': os.getcwd(), 'name': 'Experience ' + key,
                    'preview': 'UI regression fixture', 'updatedAt': time.time(), 'status': {'type': 'idle'},
                    'turns': [{'id': f'{key}-{i}', 'status': 'completed', 'items': [
                        {'id': f'{key}-u{i}', 'type': 'userMessage', 'content': [{'type': 'text', 'text': f'Task {i}'}]},
                        {'id': f'{key}-a{i}', 'type': 'agentMessage', 'phase': 'final', 'text': f'Completed response {i}'}
                    ]} for i in range(count)]}
        fixtures = {'experience-a': thread('experience-a', 85), 'experience-b': thread('experience-b', 1)}
        sockets = []
        requests = []
        def route_socket(ws):
            sockets.append(ws)
            def receive(raw):
                msg = json.loads(raw)
                requests.append(msg)
                method = msg.get('method', '')
                result = {}
                if msg['type'] == 'queue:list': result = {'items': [], 'threads': []}
                elif method in ('thread/list', 'session/list'):
                    result = {'data': [dict(value, turns=[]) for value in fixtures.values()] if msg.get('provider', 'codex') == 'codex' else [], 'nextCursor': None}
                elif method in ('thread/resume', 'thread/read'):
                    result = {'thread': fixtures[msg['params']['threadId']], 'model': 'fixture-model', 'reasoningEffort': 'medium'}
                elif method.endswith('/list'): result = {'data': []}
                elif method == 'account/rateLimits/read': result = {'rateLimits': None}
                assert method not in ('turn/start', 'run/start', 'thread/start'), 'test attempted a real task'
                ws.send(json.dumps({'type': 'reply', 'requestId': msg['requestId'], 'ok': True, 'result': result}))
            ws.on_message(receive)
        page.route_web_socket('**/ws', route_socket)
        page.goto(URL + '?provider=codex&session=experience-a', wait_until='networkidle')
        login = page.locator('input[placeholder="Password or token"]')
        if login.count():
            login.fill(PASSWORD)
            page.get_by_role('button', name='Sign in', exact=True).click()
        page.locator('.turnPanel').first.wait_for(timeout=20000)
        page.wait_for_timeout(300)
        assert page.locator('.turnPanel').count() == 40
        page.locator('.historyMoreButton').click()
        assert page.locator('.turnPanel').count() == 80
        prompt = page.locator('.composer textarea')
        prompt.fill('Keep this 中文 draft')
        prompt.press('Escape')
        assert prompt.input_value() == 'Keep this 中文 draft'
        prompt.fill('/mod')
        page.locator('.slashPalette').wait_for()
        prompt.press('Escape')
        assert prompt.input_value() == '/mod'
        assert not page.locator('.slashPalette').count()
        prompt.fill('Keep this 中文 draft')
        page.reload(wait_until='networkidle')
        page.locator('.turnPanel').first.wait_for()
        assert prompt.input_value() == 'Keep this 中文 draft'
        assert 'session=experience-a' in page.url
        b = page.locator('a.fleetSessionMain[href*="session=experience-b"]').first
        b.click()
        page.wait_for_timeout(300)
        assert prompt.input_value() == '', {'url':page.url, 'draft':prompt.input_value(), 'requests':requests[-8:], 'errors':errors}
        prompt.fill('Second session draft')
        assert 'session=experience-b' in page.url
        page.go_back()
        page.wait_for_timeout(350)
        assert 'session=experience-a' in page.url
        assert prompt.input_value() == 'Keep this 中文 draft'
        page.go_forward()
        page.wait_for_timeout(350)
        assert prompt.input_value() == 'Second session draft'
        page.get_by_role('button', name='Session settings').click()
        page.wait_for_timeout(100)
        assert 'view=runtime' in page.url
        page.reload(wait_until='networkidle')
        page.locator('.runtimePanel').wait_for()
        assert prompt.input_value() == 'Second session draft'
        page.get_by_role('button', name='Close context', exact=True).click()
        ws = sockets[-1]
        def emit(method, params):
            ws.send(json.dumps({'type': 'codex:notification', 'message': {'method': method, 'params': dict(params, threadId='experience-b')}}))
        accepted = int(time.time() * 1000) - 1000
        queued = {'id': 'queued-experience-test', 'provider': 'codex', 'threadKey': 'codex:experience-b',
                  'threadId': 'experience-b', 'text': 'Streaming regression', 'cwd': os.getcwd(),
                  'threadParams': {}, 'turnParams': {}, 'status': 'running', 'runId': 'stream-turn',
                  'attempts': 1, 'lastError': None, 'baseTree': None, 'diff': None,
                  'createdAt': accepted / 1000, 'updatedAt': time.time(),
                  'timings': {'acceptedAt': accepted, 'dispatchAt': accepted + 100,
                              'resumeAt': accepted + 100, 'resumedAt': accepted + 200,
                              'startRequestedAt': accepted + 200, 'startedAt': accepted + 300}}
        ws.send(json.dumps({'type': 'queue:snapshot', 'snapshot': {'items': [queued], 'threads': []}}))
        page.get_by_text('Waiting for first output', exact=True).wait_for()
        page.locator('.runProgress summary').click()
        assert '0.10s' in page.locator('.runProgress').inner_text()
        page.locator('.runProgress summary').click()
        emit('turn/started', {'turn': {'id': 'stream-turn', 'status': 'inProgress', 'items': [], 'startedAt': time.time()}})
        emit('item/started', {'turnId': 'stream-turn', 'item': {'id': 'stream-user', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'Streaming regression'}]}})
        emit('item/started', {'turnId': 'stream-turn', 'item': {'id': 'stream-agent', 'type': 'agentMessage', 'phase': 'final', 'text': ''}})
        visible_during_stream = False
        for i in range(35):
            emit('item/agentMessage/delta', {'turnId': 'stream-turn', 'itemId': 'stream-agent', 'delta': f'word{i} '})
            page.wait_for_timeout(25)
            if i == 20:
                visible_during_stream = 'word' in page.locator('.turnPanel').first.inner_text()
        assert visible_during_stream, 'continuous stream starved Markdown updates'
        final = ''.join(f'word{i} ' for i in range(35))
        emit('item/completed', {'turnId': 'stream-turn', 'item': {'id': 'stream-agent', 'type': 'agentMessage', 'phase': 'final', 'text': final}})
        emit('turn/completed', {'turn': {'id': 'stream-turn', 'status': 'completed', 'items': [], 'completedAt': time.time()}})
        page.wait_for_timeout(200)
        assert 'word34' in page.locator('.turnPanel').first.inner_text()
        assert prompt.input_value() == 'Second session draft'
        queued['status'] = 'completed'
        queued['timings']['firstOutputAt'] = accepted + 400
        queued['timings']['completedAt'] = int(time.time() * 1000)
        ws.send(json.dumps({'type': 'queue:snapshot', 'snapshot': {'items': [queued], 'threads': []}}))
        prompt.evaluate('(e) => {e.focus(); e.setSelectionRange(3, 3)}')
        emit('thread/tokenUsage/updated', {'tokenUsage': {'last': {'inputTokens': 123000}, 'total': {'totalTokens': 3100000}, 'modelContextWindow': 1000000}})
        page.wait_for_timeout(150)
        assert prompt.evaluate('(e) => e.selectionStart') == 3, 'parent update moved the editing caret'
        for width, height in [(1440, 1000), (768, 1024), (390, 844), (320, 700)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.wait_for_timeout(150)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'overflow at {width}'
            action = page.locator('.mobileToolsButton') if width <= 760 else page.get_by_role('button', name='Log out')
            box = action.bounding_box()
            assert box and box['x'] + box['width'] <= width + 1, 'header action clipped'
            page.screenshot(path=f'/tmp/codex-experience-{width}.png')
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.get_by_role('button', name='Session settings').click()
        page.get_by_role('button', name='Continue in a new session', exact=True).click()
        page.wait_for_timeout(150)
        assert 'session=' not in page.url
        assert 'Handoff excerpts' in prompt.input_value()
        assert 'word34' in prompt.input_value()
        page.reload(wait_until='networkidle')
        page.locator('.appShell').wait_for()
        assert 'Handoff excerpts' in prompt.input_value()
        assert not errors, errors
        print(json.dumps({'drafts': 'escape, reload, session isolation passed', 'navigation': 'deep link, Back, Forward, tab reload passed', 'history': '40 then 80 passed', 'streaming': 'continuous 25ms deltas rendered before completion; final text complete', 'viewports': [1440, 768, 390, 320], 'errors': errors}, ensure_ascii=False))
        browser.close()


if __name__ == '__main__':
    main()
