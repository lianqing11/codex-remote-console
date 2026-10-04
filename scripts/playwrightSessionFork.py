"""Fork UI acceptance against an isolated candidate and the opt-in live smoke fixtures."""
import asyncio
import json
import os
import pathlib
from playwright.async_api import async_playwright

URL = os.environ.get("CODING_AGENT_CONSOLE_TEST_URL", "http://127.0.0.1:1818/codex-fork-preview/")
ROOT = pathlib.Path(os.environ["FORK_SMOKE_ROOT"])
PASSWORD = os.environ.get("CODEX_WEB_PASSWORD") or os.environ.get("CODEX_WEB_TOKEN") or ""

async def main():
    fixtures = json.loads((ROOT / "results.json").read_text())
    assert all(row["result"] == "passed" for row in fixtures)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 1000})
        await context.add_init_script("""(() => {
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function(raw) {
            const msg = JSON.parse(raw);
            if (window.__failNextFork && msg.type === 'agent:request' && msg.method === 'thread/fork') {
              window.__failNextFork = false;
              setTimeout(() => this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({type:'reply',requestId:msg.requestId,ok:false,error:'Synthetic fork failure'})})), 30);
              return;
            }
            return send.call(this, raw);
          };
        })();""")
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(URL, wait_until="networkidle")
        if await page.locator('input[placeholder="Password or token"]').count():
            await page.locator('input[placeholder="Password or token"]').fill(PASSWORD)
            await page.get_by_role("button", name="Sign in", exact=True).click()
        await page.locator(".appShell").wait_for(timeout=30000)
        await page.evaluate("cwd => { localStorage.setItem('coding-agent-console.cwd',cwd); localStorage.setItem('coding-agent-console.recentDirs',JSON.stringify([cwd])); }", str(ROOT))
        await page.reload(wait_until="networkidle")
        await page.locator(".statusPill.online").wait_for(timeout=30000)
        reports = []
        for fixture in fixtures:
            provider, parent = fixture["provider"], fixture["parentId"]
            row = page.locator(f'.fleetSessionRow[data-session-key="{provider}:{parent}"]').first
            await row.locator('.fleetSessionMain').click()
            await page.locator(".turnPanel").first.wait_for(timeout=30000)
            fork = page.get_by_role("button", name="Fork session", exact=True)
            await fork.wait_for()
            assert await fork.is_enabled(), await fork.get_attribute("title")
            # The operation menu and slash palette expose the same provider capability.
            await row.locator('.fleetRowMenu summary').click()
            assert await row.get_by_role('menuitem', name='Fork session', exact=True).is_enabled()
            await row.locator('.fleetRowMenu summary').click()
            composer = page.locator('.composer textarea').first
            await composer.fill('/fork')
            assert await page.locator('.slashCommand', has_text='/fork').count()
            await page.evaluate('window.__failNextFork = true')
            await composer.press('Enter')
            await page.get_by_text('Synthetic fork failure', exact=True).wait_for(timeout=10000)
            assert await composer.input_value() == '/fork'
            await composer.fill('keep-parent-draft')
            before = await page.locator('.turnPanel').count()
            await fork.click()
            await page.get_by_text('Session forked. Project files are shared.', exact=True).wait_for(timeout=30000)
            await page.locator('.forkParentLink').wait_for()
            assert await page.locator('.turnPanel').count() == before
            assert await composer.input_value() == ''
            # Native ID comes from the newly selected row, for reload and branch checks.
            child_row = page.locator('.fleetSessionRow.selected').first
            child_key = await child_row.get_attribute('data-session-key')
            assert child_key and child_key != f'{provider}:{parent}'
            await page.locator('.forkParentLink').click()
            assert await composer.input_value() == 'keep-parent-draft'
            await page.locator(f'.fleetSessionRow[data-session-key="{child_key}"]').first.locator('.fleetSessionMain').click()
            await page.reload(wait_until='networkidle')
            await page.locator('.statusPill.online').wait_for(timeout=30000)
            await page.locator(f'.fleetSessionRow[data-session-key="{child_key}"]').first.locator('.fleetSessionMain').click()
            await page.locator('.forkParentLink').wait_for(timeout=30000)
            assert await page.locator('.turnPanel').count() == before
            if provider in ('codex', 'claude'):
                if await page.locator('.turnPanel').first.get_attribute('open') is None:
                    await page.locator('.turnPanel').first.locator('summary').first.click()
                assert await page.get_by_role('button', name='Fork from this turn', exact=True).count() >= 1
            else:
                assert await page.get_by_role('button', name='Fork from this turn', exact=True).count() == 0
            await page.screenshot(path=f'/tmp/fork-{provider}-desktop.png', full_page=True)
            await page.set_viewport_size({'width':390,'height':844})
            await page.wait_for_timeout(200)
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            assert await page.locator('.sessionForkBar').is_visible()
            await page.screenshot(path=f'/tmp/fork-{provider}-mobile.png', full_page=True)
            await page.set_viewport_size({'width':1440,'height':1000})
            reports.append({'provider':provider,'parent':parent,'child':child_key,'historyTurns':before,'failureDraft':'preserved','reload':'passed','mobile':'passed'})
        assert not errors, errors
        print(json.dumps({'url':URL,'results':reports},ensure_ascii=False,indent=2))
        await browser.close()

asyncio.run(main())
