import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const engines = ['codex', 'claude', 'grok'];
function readiness(state = 'ready', reasons: string[] = []) {
  return { state, reasons, cli_version: '1.2.3', cli_target: '1.2.3', wrapper_version: '0.9.40', wrapper_target: '0.9.40' };
}
function state() {
  const common = { status: 'active', engines: 'codex,claude,grok', engines_list: engines,
    last_refresh: new Date().toISOString(), updated_at: new Date().toISOString(), claude_last_refresh: null,
    client_version: '1.2.3', client_version_override: null, wrapper_version: '0.9.40',
    secure: true, vip: false, ip4: '192.0.2.10', insecure_enabled_until: null,
    canonical_digest: 'old-auth', claude_canonical_digest: null, grok_canonical_digest: 'old-auth',
    authed: false, auth_outdated: true, users: [],
  };
  return { suspended: [] as string[], rows: [
    { ...common, id: 1, fqdn: 'secure.test', engine_readiness: { codex: readiness(), claude: readiness('attention', ['auth_missing']), grok: readiness('attention', ['wrapper_outdated']) } },
    { ...common, id: 2, fqdn: 'insecure.test', secure: false, canonical_digest: null, engine_readiness: { codex: readiness(), claude: readiness(), grok: readiness('attention', ['cli_unknown']) } },
    { ...common, id: 3, fqdn: 'unassigned.test', engines: 'codex', engines_list: ['codex'], engine_readiness: { codex: readiness(), claude: readiness('inactive', ['not_assigned']), grok: readiness('inactive', ['not_assigned']) } },
    { ...common, id: 4, fqdn: 'legacy.test', engine_readiness: undefined },
  ] };
}
async function fixture(page: Page, shared: ReturnType<typeof state>) {
  let emit: ((data: string) => void) | undefined;
  await page.routeWebSocket('**/host-readiness-ws', ws => { emit = data => ws.send(data); });
  await page.route('**/admin/**', route => {
    const request = route.request(); if (!request.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(request.url()).pathname;
    const json = (data: unknown) => route.fulfill({ json: { status: 'ok', data } });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'owner', roles: ['owner'] }, capabilities: ['admin.read', 'hosts.read', 'settings.read'] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: '2026-10-09T10:00:00Z', dismissed_at: null } });
    if (path === '/admin/ws/info') return json({ enabled: true, url: 'ws://127.0.0.1:4173/host-readiness-ws' });
    if (path === '/admin/hosts') return json({ hosts: shared.rows });
    if (path === '/admin/engines/state') return json({ engines: engines.map(engine => ({ engine, enabled: !shared.suspended.includes(engine) })) });
    if (path === '/admin/insecure-approvals/pending') return json({ requests: [] });
    if (path === '/admin/insecure-window') return json({ enabled_until: null });
    return json({});
  });
  return async (type: string) => { await expect.poll(() => Boolean(emit)).toBe(true); emit!(JSON.stringify({ type, payload: {}, ts: new Date().toISOString() })); };
}
function row(page: Page, fqdn: string) { return page.getByRole('button').filter({ has: page.getByText(fqdn, { exact: true }) }); }
for (const width of [390, 1440]) test(`engine readiness replaces Status (${width}px)`, async ({ page }) => {
  const shared = state(); await page.setViewportSize({ width, height: 900 }); await fixture(page, shared); await page.goto('/admin/hosts?sort=status');
  await expect(row(page, 'secure.test')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Status', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Host', exact: true })).toContainText('Host');
  await expect(row(page, 'secure.test').getByRole('img', { name: /^Codex: ready/ })).toHaveAttribute('data-state', 'ready');
  await expect(row(page, 'secure.test').getByRole('img', { name: /^Claude: auth missing/ })).toHaveAttribute('data-state', 'attention');
  await expect(row(page, 'secure.test').getByRole('img', { name: /^Grok: wrapper not at target/ })).toHaveAttribute('data-state', 'attention');
  await expect(row(page, 'insecure.test').getByRole('img', { name: /^Claude: ready/ })).toHaveAttribute('data-state', 'ready');
  await expect(row(page, 'insecure.test').getByRole('img', { name: /^Grok: CLI version or target unknown/ })).toHaveAttribute('data-state', 'attention');
  await expect(row(page, 'unassigned.test').getByRole('img', { name: /^Claude: not assigned/ })).toHaveAttribute('data-state', 'inactive');
  await expect(row(page, 'legacy.test').getByRole('img', { name: /^Codex: status unknown/ })).toHaveAttribute('data-state', 'attention');
  const dot = row(page, 'secure.test').getByRole('img', { name: /^Codex: ready/ });
  await expect(dot).toHaveAttribute('title', /CLI 1.2.3 \/ target 1.2.3 · cxx 0.9.40 \/ target 0.9.40/);
  await expect(dot.locator('span')).toHaveClass(/bg-green-500/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `test-results/host-readiness-${width}.png`, fullPage: true });
});
test('host, settings and fleet events refresh dots without a page reload', async ({ page }) => {
  const shared = state(); const emit = await fixture(page, shared); await page.goto('/admin/hosts');
  const claude = row(page, 'secure.test').getByRole('img', { name: /^Claude:/ });
  await expect(claude).toHaveAttribute('data-state', 'attention');
  shared.rows[0].engine_readiness!.claude = readiness(); await emit('host.updated'); await expect(claude).toHaveAttribute('data-state', 'ready');
  shared.rows[0].engine_readiness!.claude = readiness('attention', ['cli_outdated']); await emit('settings.changed'); await expect(claude).toHaveAttribute('data-state', 'attention');
  shared.suspended = ['codex']; await emit('engine.state.changed');
  await expect(row(page, 'secure.test').getByRole('img', { name: /^Codex: disabled fleet-wide/ })).toHaveAttribute('data-state', 'inactive');
});
