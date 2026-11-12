import { expect, test } from '@playwright/test';
import { ownerStream } from './owner-stream';

// The fleet pushes `settings.changed` often. A refresh of data that is already shown must not lock
// switches or flash status text, or the page flickers with every event.
test('background refreshes never lock controls or flash status text', async ({ page }) => {
  let emit: ((d: string) => void) | undefined;
  await page.routeWebSocket('**/blink-ws', ws => { ownerStream(ws); emit = d => ws.send(d); });
  await page.route('**/admin/**', async route => {
    const req = route.request();
    if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname, json = (b: unknown, s = 200) => route.fulfill({ status: s, json: b });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'o', roles: ['owner'] }, capabilities: ['admin.read','settings.read','settings.manage','security.manage_authorization','agent_messaging.read','agent_messaging.manage','agent_portal.manage','hosts.read','hosts.manage','chatty.manage'] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: 'x', dismissed_at: null } });
    if (path === '/admin/ws/info') return json({ enabled: true, url: new URL('/blink-ws', req.url()).href.replace(/^http/, 'ws') });
    await new Promise(r => setTimeout(r, 150)); // realistic latency
    if (path === '/admin/agent-supervisor') return json({ enabled: true, effective: true, dependencies: [], states: [] });
    if (path === '/admin/agent-messaging/scopes/state') return json({ enabled: true });
    if (/auto-update|reverse-dns|insecure-approval|host-spawn|api-keys-in-chat|model-tier|subagent/.test(path)) return json({ status: 'ok', data: { enabled: true } });
    return json({});
  });
  for (const group of ['hosts', 'agents']) {
    await page.goto(`/admin/settings?group=${group}`);
    await expect(page.getByRole('switch').first()).toBeEnabled();
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const w = window as any; w.__log = []; let prev = '';
      setInterval(() => {
        const sw = [...document.querySelectorAll('[role=switch]')].filter(e => (e as HTMLButtonElement).disabled).length;
        const refreshing = /Refreshing current state|Loading current setting/.test(document.body.innerText);
        const sig = `${sw}|${refreshing}`; if (sig !== prev) { w.__log.push([Math.round(performance.now()), sig]); prev = sig; }
      }, 16);
    });
    for (let i = 0; i < 3; i++) {
      emit!(JSON.stringify({ type: 'settings.changed', payload: {} }));
      await page.waitForTimeout(600);
    }
    const log = await page.evaluate(() => (window as any).__log) as Array<[number, string]>;
    // Only the initial reading may appear: no switch ever disabled, no refresh text.
    expect(log.map(([, sig]) => sig), `${group}: ${JSON.stringify(log)}`).toEqual(['0|false']);
  }
});
