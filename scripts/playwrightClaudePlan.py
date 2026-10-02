"""Test Plan -> Agent against an isolated backend and deterministic fake CLIs.

Build with NEXT_DIST_DIR=.next-claude-plan NEXT_PUBLIC_BASE_PATH=/codex_web_cursor
before running. No live sessions, credentials, queue, or model calls are used.
"""
import json
import os
import pathlib
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import expect, sync_playwright


FAKE_CLAUDE = r'''#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-claude'); process.exit(0); }
if (args[0] === 'auth') { console.log('logged in'); process.exit(0); }
if (!args.includes('-p')) process.exit(1);
const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const permission = args[args.indexOf('--permission-mode') + 1];
fs.appendFileSync(process.env.CLAUDE_PLAN_FIXTURE_LOG, JSON.stringify({ id, permission, resume: args.includes('--resume') }) + '\n');
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, id + '.jsonl');
function row(value) { fs.appendFileSync(file, JSON.stringify({ cwd: process.cwd(), timestamp: new Date().toISOString(), ...value }) + '\n'); }
function send(value) { console.log(JSON.stringify(value)); }
row({ type: 'user', uuid: crypto.randomUUID(), message: { content: args.at(-1) } });
const progress = { id: crypto.randomUUID(), content: [{ type: 'text', text: 'Inspecting the fixture workspace.' }] };
row({ type: 'assistant', message: progress });
send({ type: 'assistant', message: progress });
setTimeout(() => {
  const text = permission === 'plan' ? '1. Update the fixture.\n2. Run verification.\nCLAUDE_PLAN_READY' : 'CLAUDE_PLAN_EXECUTED';
  const message = { id: crypto.randomUUID(), content: [{ type: 'text', text }] };
  row({ type: 'assistant', message });
  send({ type: 'assistant', message });
  send({ type: 'result', subtype: 'success', result: text });
}, 3500);
'''

FAKE_CODEX = r'''#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fixture-codex'); process.exit(0); }
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = { data: [], nextCursor: null };
  if (request.method === 'initialize') result = { userAgent: 'fixture-codex' };
  console.log(JSON.stringify({ id: request.id, result }));
});
'''


def main():
    repo = pathlib.Path(__file__).resolve().parents[1]
    dist = os.environ.get('NEXT_DIST_DIR', '.next-claude-plan')
    assert (repo / dist / 'BUILD_ID').exists(), f'Build {dist} before running this test'
    root = pathlib.Path(tempfile.mkdtemp(prefix='claude-plan-ui-'))
    workspace = root / 'workspace'
    workspace.mkdir()
    subprocess.run(['git', 'init', '-q', str(workspace)], check=True)
    bins = root / 'bin'
    bins.mkdir()
    for name, source in [('claude', FAKE_CLAUDE), ('codex', FAKE_CODEX),
                         ('cursor-agent', '#!/usr/bin/env node\nconsole.log("fixture-cursor");\n')]:
        executable = bins / name
        executable.write_text(source)
        executable.chmod(0o755)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    state = root / 'state'
    invocations = root / 'invocations.jsonl'
    environment = dict(os.environ, NODE_ENV='production', HOST='127.0.0.1', PORT=str(port),
                       NEXT_DIST_DIR=dist, NEXT_PUBLIC_BASE_PATH='/codex_web_cursor',
                       PATH=str(bins) + os.pathsep + os.environ['PATH'],
                       CODEX_WEB_PASSWORD='claude-plan-fixture', CODEX_WEB_TOKEN='',
                       CODEX_WEB_SECRET='claude-plan-fixture-secret', CODEX_WEB_FEISHU_NOTIFY='0',
                       CODEX_WEB_PROXY_URL='', CODEX_WEB_COOKIE_SECURE='false',
                       CODING_AGENT_CONSOLE_STATE_DIR=str(state),
                       CLAUDE_CONFIG_DIR=str(root / 'claude-home'), CLAUDE_PLAN_FIXTURE_LOG=str(invocations))
    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        environment.pop(key, None)
    url = f'http://127.0.0.1:{port}/'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    log = (root / 'server.log').open('w')
    server = subprocess.Popen(['node', '--import', 'tsx', 'server/index.ts'], cwd=repo,
                              env=environment, stdout=log, stderr=subprocess.STDOUT)
    results = []
    page = None
    try:
        deadline = time.monotonic() + 30
        while True:
            assert server.poll() is None, f'Isolated server exited; see {root / "server.log"}'
            try:
                with opener.open(url, timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            assert time.monotonic() < deadline, 'Isolated server did not become ready'
            time.sleep(0.2)
        with sync_playwright() as playwright:
            launch = {'headless': True, 'args': ['--no-proxy-server']}
            if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'):
                launch['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']
            browser = playwright.chromium.launch(**launch)
            for label, viewport in [('desktop', {'width': 1440, 'height': 1000}),
                                    ('mobile', {'width': 390, 'height': 844})]:
                context = browser.new_context(viewport=viewport)
                context.add_init_script('''localStorage.setItem('coding-agent-console.provider', 'claude');
                    localStorage.setItem('coding-agent-console.cwd', ''' + json.dumps(str(workspace)) + ');')
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
                # Emulate the gateway's asset-prefix stripping for this loopback-only server.
                page.route('**/codex_web_cursor/_next/**', lambda route: route.fulfill(
                    response=route.fetch(url=route.request.url.replace('/codex_web_cursor/_next/', '/_next/'))))
                page.goto(url, wait_until='networkidle')
                page.locator('input[placeholder="Password or token"]').fill('claude-plan-fixture')
                page.get_by_role('button', name='Sign in', exact=True).click()
                page.locator('.statusPill.online').wait_for(state='attached', timeout=20000)
                if label == 'mobile':
                    page.get_by_role('button', name='Sessions', exact=True).click()
                    page.locator('.sidebar.mobileOpen').wait_for()
                new_session = page.get_by_role('button', name='New session', exact=True)
                if new_session.count():
                    new_session.click()
                new_claude = page.get_by_role('button', name='New Claude', exact=True)
                if not new_claude.is_visible():
                    page.get_by_role('button', name='Sessions', exact=True).click()
                new_claude.click()
                page.locator('.sessionModeSwitch').get_by_role('button', name='Plan', exact=True).click()
                page.locator('.composer textarea').fill('Plan a small fixture change without modifying files.')
                page.locator('.composer .primaryButton').click()
                control = page.locator('.sessionExecutionControl')
                expect(control).to_have_attribute('data-execution-phase', 'running', timeout=20000)
                expect(page.get_by_role('button', name='Execute plan', exact=True)).to_have_count(0)
                expect(page.get_by_role('button', name='Waiting for plan…', exact=True)).to_be_disabled()
                session_key = control.get_attribute('data-session-key')
                page.reload(wait_until='networkidle')
                execute = page.get_by_role('button', name='Execute plan', exact=True)
                expect(execute).to_be_enabled(timeout=20000)
                expect(control).to_have_attribute('data-session-key', session_key)
                page.reload(wait_until='networkidle')
                expect(execute).to_be_enabled(timeout=20000)
                expect(control).to_have_attribute('data-execution-mode', 'plan')
                page.screenshot(path=str(root / f'{label}-plan-ready.png'), full_page=True)
                execute.evaluate('(button) => { button.click(); button.click(); }')
                expect(control).to_have_attribute('data-execution-mode', 'default', timeout=20000)
                expect(control).to_have_attribute('data-execution-phase', 'idle', timeout=20000)
                expect(control).to_have_attribute('data-session-key', session_key)
                expect(page.locator('.turnFinalAnswer').filter(has_text='CLAUDE_PLAN_EXECUTED')).to_have_count(1, timeout=20000)
                expect(execute).to_have_count(0)
                page.reload(wait_until='networkidle')
                expect(control).to_have_attribute('data-execution-mode', 'default', timeout=20000)
                expect(control).to_have_attribute('data-session-key', session_key)
                expect(execute).to_have_count(0)
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'horizontal overflow'
                calls = [json.loads(line) for line in invocations.read_text().splitlines()]
                own_calls = [call for call in calls if 'claude:' + call['id'] == session_key]
                assert len(own_calls) == 2, f'Expected one Plan and one execution: {own_calls}'
                assert own_calls[0]['permission'] == 'plan'
                assert own_calls[1]['permission'] == 'acceptEdits' and own_calls[1]['resume']
                with sqlite3.connect(f'file:{state / "queue.sqlite"}?mode=ro', uri=True) as conn:
                    queued = conn.execute('SELECT status FROM queue_items WHERE thread_key=?', (session_key,)).fetchall()
                assert queued == [('completed',), ('completed',)], queued
                assert not errors, errors
                page.screenshot(path=str(root / f'{label}-agent-complete.png'), full_page=True)
                results.append({'viewport': label, 'same_session': True, 'invocations': 2, 'errors': 0})
                context.close()
            browser.close()
        (root / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps({'results': results, 'artifacts': str(root)}))
    except Exception:
        if page and not page.is_closed():
            try:
                page.screenshot(path=str(root / 'failure.png'), full_page=True)
                (root / 'failure.txt').write_text(page.locator('body').inner_text())
            except Exception:
                pass
        print(json.dumps({'failure_artifacts': str(root)}))
        raise
    finally:
        server.terminate()
        server.wait(timeout=15)
        log.close()


if __name__ == '__main__':
    main()
