import { expect, test, type Page } from '@playwright/test';
const rule = { enabled: true, retention_days: 30, max_bytes: 5 * 1024 ** 3, min_age_days: 7 };
function effective(value = rule) { return { ...value, source: 'fleet', override: null, fleet: { ...value } }; }
async function fixture(page: Page, manage = true) {
  const policies = { codex: effective(), claude: effective(), grok: effective() };
  const writes: { engine: string; value: typeof rule }[] = [];
  let emit: ((content: string) => void) | undefined;
  await page.routeWebSocket('**/housekeeping-ws', ws => { emit = content => ws.send(content); });
  await page.route('**/admin/**', route => {
    const req = route.request(); if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (data: unknown) => route.fulfill({ json: { status: 'ok', data } });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'operator', roles: [manage ? 'owner' : 'viewer'] }, capabilities: ['admin.read', 'settings.read', ...(manage ? ['settings.manage'] : [])] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: new Date().toISOString() } });
    if (path === '/admin/ws/info') return json({ enabled: true, url: new URL('/housekeeping-ws', req.url()).href.replace(/^http/, 'ws') });
    if (path === '/admin/session-housekeeping') return json(policies);
    if (path.startsWith('/admin/session-housekeeping/')) {
      const engine = path.split('/').pop() as keyof typeof policies;
      const value = req.postDataJSON(); writes.push({ engine, value }); policies[engine] = effective(value); return json(policies[engine]);
    }
    if (path === '/admin/log-retention') return json({ enabled: false, days_logs: 90, days_mcp: 90, days_events: 30, days_graph_stats: 180 });
    if (path === '/admin/authorization') return json({ mode: 'compatible', updated_at: null, would_deny: [] });
    if (['auto-update', 'reverse-dns', 'api-keys-in-chat', 'remote-exec', 'insecure-approval'].includes(path.split('/').pop()!)) return json({ enabled: false });
    if (path === '/admin/overview') return json({ inactivity_window_days: 30 });
    return json({});
  });
  return { policies, writes, update: async () => { await expect.poll(() => !!emit).toBe(true); emit!(JSON.stringify({ type: 'settings.changed', payload: {}, ts: new Date().toISOString() })); } };
}
test('saves independent engine rules and validates minimum age', async ({ page }) => {
  const f = await fixture(page); await page.goto('/admin/policies#session-housekeeping');
  const card = page.locator('#session-housekeeping'); await expect(card.getByLabel('Retention (days)')).toHaveValue('30');
  await card.getByLabel('Engine', { exact: true }).selectOption('grok');
  await card.getByLabel('Retention (days)').fill('60');
  await card.getByLabel('Budget (GiB)').fill('8');
  await card.getByRole('button', { name: 'Save rule', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0]).toEqual({ engine: 'grok', value: { ...rule, retention_days: 60, max_bytes: 8 * 1024 ** 3 } });
  await expect(card.getByText('Rule saved.')).toBeVisible();
  await card.getByLabel('Engine', { exact: true }).selectOption('codex'); await expect(card.getByLabel('Retention (days)')).toHaveValue('30');
  await card.getByLabel('Minimum age under pressure (days)').fill('31'); await expect(card.getByRole('button', { name: 'Save rule', exact: true })).toBeDisabled();
});
test('preserves drafts and blocks overwriting a remotely changed rule', async ({ page }) => {
  const f = await fixture(page); await page.goto('/admin/policies#session-housekeeping');
  const card = page.locator('#session-housekeeping'); await expect(card.getByLabel('Retention (days)')).toHaveValue('30');
  await card.getByLabel('Retention (days)').fill('45'); f.policies.codex = effective({ ...rule, retention_days: 60 }); await f.update();
  await expect(card.getByText('The saved rule changed. Reload it before saving.')).toBeVisible(); await expect(card.getByLabel('Retention (days)')).toHaveValue('45');
  await expect(card.getByRole('button', { name: 'Save rule', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: 'Reload saved rule' }).click(); await expect(card.getByLabel('Retention (days)')).toHaveValue('60'); expect(f.writes).toHaveLength(0);
});
test('read-only operators cannot change housekeeping', async ({ page }) => {
  await fixture(page, false); await page.goto('/admin/policies#session-housekeeping');
  const card = page.locator('#session-housekeeping'); await expect(card.getByLabel('Retention (days)')).toHaveValue('30'); await expect(card.getByLabel('Enable automatic housekeeping')).toBeDisabled(); await expect(card.getByRole('button', { name: 'Save rule', exact: true })).toBeDisabled();
});
