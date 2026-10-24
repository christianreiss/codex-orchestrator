import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
function state() {
  return { values: {
    'auto-update': { enabled: false }, 'reverse-dns': { enabled: true },
    'api-keys-in-chat': { enabled: true }, 'insecure-approval': { enabled: false },
    authorization: { mode: 'compatible', updated_at: null, would_deny: [{ role: 'operator', capability: 'security.manage_authorization', route: 'POST /admin/authorization', first_seen: '2026-10-09T08:00:00Z', last_seen: '2026-10-09T08:00:00Z' }] },
    'prune-policy': { inactivity_window_days: 30 },
  } as Record<string, Record<string, unknown>>, writes: [] as { key: string; body: Record<string, unknown> }[], fail: '', readFail: '' };
}
async function fixture(page: Page, shared: ReturnType<typeof state>, manage = true) {
  let emit: ((data: string) => void) | undefined;
  await page.routeWebSocket('**/policies-ws', ws => { emit = data => ws.send(data); });
  await page.route('**/admin/**', route => {
    const req = route.request();
    if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname, key = path.split('/').pop()!;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'operator', roles: [manage ? 'owner' : 'viewer'] }, capabilities: ['admin.read', 'settings.read', ...(manage ? ['settings.manage', 'security.manage_authorization'] : [])] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: '2026-10-09T08:00:00Z', dismissed_at: null } });
    if (path === '/admin/ws/info') return json({ enabled: true, url: new URL('/policies-ws', req.url()).href.replace(/^http/, 'ws') });
    if (path === '/admin/overview') return shared.readFail === 'prune-policy' ? json({ status: 'error', message: 'Read unavailable' }, 503) : json(shared.values['prune-policy']);
    if (shared.values[key]) {
      if (req.method() === 'POST') {
        const body = req.postDataJSON(); shared.writes.push({ key, body });
        if (shared.fail === key) return json({ status: 'error', message: 'Save unavailable' }, 503);
        shared.values[key] = key === 'prune-policy' ? { inactivity_window_days: body.inactivity_days } : { ...shared.values[key], ...body };
      } else if (shared.readFail === key) return json({ status: 'error', message: 'Read unavailable' }, 503);
      return json({ status: 'ok', data: shared.values[key] });
    }
    return json({});
  });
  return async () => { await expect.poll(() => Boolean(emit)).toBe(true); emit!(JSON.stringify({ type: 'settings.changed', payload: {}, ts: new Date().toISOString() })); };
}
const ANCHORS = ['hosts', 'agents', 'retention', 'auto-update', 'reverse-dns', 'insecure-approval', 'host-spawn', 'api-keys-in-chat', 'model-tier-check', 'authorization', 'host-lifecycle', 'prune-policy', 'session-housekeeping'];
test('one flat page keeps drafts, resolves anchors and has no duplicate IDs', async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto('/admin/settings');
  for (const name of ['Hosts', 'Agents', 'Data retention']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Policy categories' })).toHaveCount(0);
  const days = page.getByLabel('Inactivity window (days)');
  await expect(days).toHaveValue('30'); await days.fill('12');
  await page.getByRole('switch', { name: 'Look up host names', exact: true }).focus();
  await expect(days).toHaveValue('12');
  await page.locator('#prune-policy').getByRole('button', { name: 'Reset', exact: true }).click(); await expect(days).toHaveValue('30');
  for (const anchor of ANCHORS) { await page.goto(`/admin/settings#${anchor}`); await expect(page.locator(`#${anchor}`)).toBeVisible(); }
  expect(shared.writes).toEqual([]);
  expect(await page.locator('[id]').evaluateAll(nodes => { const ids = nodes.map(n => n.id); return ids.filter((id, i) => ids.indexOf(id) !== i); })).toEqual([]);
});
test('legacy settings bookmarks redirect to their new section', async ({ page }) => {
  const shared = state(); await fixture(page, shared);
  await page.goto('/admin/settings?tab=fleet-policy'); await expect(page).toHaveURL(/\/admin\/settings$/);
  await page.goto('/admin/settings?tab=general'); await expect(page).toHaveURL(/\/admin\/api-keys$/);
  await page.goto('/admin/settings#log-retention'); await expect(page).toHaveURL(/\/admin\/settings#retention$/);
});
test('immediate controls save, reload and recover after failure', async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto('/admin/settings');
  const toggle = page.getByRole('switch', { name: 'Update hosts automatically', exact: true });
  await expect(toggle).toBeEnabled(); shared.fail = 'auto-update'; await toggle.click();
  await expect(page.locator('#auto-update')).toContainText('Save failed'); await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
  shared.fail = ''; await toggle.click(); await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
  const chat = page.getByRole('switch', { name: 'Tell agents how to treat keys pasted in chat', exact: true });
  await chat.click(); await expect(chat).not.toBeChecked();
  const mode = page.getByLabel('Role checks');
  shared.fail = 'authorization'; await mode.selectOption('strict'); await expect(page.locator('#authorization')).toContainText('Save failed'); await expect(mode).toHaveValue('compatible'); await expect(mode).toBeEnabled();
  shared.fail = ''; await mode.selectOption('strict'); await expect(mode).toHaveValue('strict'); await expect(mode).toBeEnabled();
  const approval = page.getByRole('switch', { name: 'Allow temporary-access requests', exact: true });
  await approval.click(); await expect(approval).toBeChecked();
  await page.reload(); await expect(mode).toHaveValue('strict');
});
test('numeric validation preserves inactive-host policy and retired retention is absent', async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto('/admin/settings');
  const prune = page.locator('#prune-policy');
  const days = prune.getByLabel('Inactivity window (days)'), save = prune.getByRole('button', { name: 'Save changes' });
  await expect(days).toHaveValue('30'); await expect(save).toBeDisabled();
  for (const value of ['1.5', '-1', '61', '']) { await days.fill(value); await expect(save).toBeDisabled(); await expect(days).toHaveAttribute('aria-invalid', 'true'); }
  await days.fill('0'); await save.click(); await expect(prune).toContainText('inactivity pruning disabled'); await expect(save).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Remove old logs automatically' })).toHaveCount(0);
  await expect(page.getByLabel('MCP logs (days)')).toHaveCount(0);
});
test('external updates refresh pristine values and protect dirty drafts', async ({ page }) => {
  const shared = state(); const refresh = await fixture(page, shared); await page.goto('/admin/settings');
  const prune = page.locator('#prune-policy'), days = prune.getByLabel('Inactivity window (days)');
  await expect(days).toHaveValue('30'); shared.values['prune-policy'].inactivity_window_days = 20; await refresh(); await expect(days).toHaveValue('20');
  await days.fill('12'); shared.values['prune-policy'].inactivity_window_days = 40; await refresh();
  await expect(prune).toContainText('Saved values changed elsewhere'); await expect(days).toHaveValue('12'); await expect(prune.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await prune.getByRole('button', { name: 'Reset', exact: true }).click(); await expect(days).toHaveValue('40');

});
test('failed reads disable writes and offer retry', async ({ page }) => {
  const shared = state(); shared.readFail = 'auto-update'; await fixture(page, shared); await page.goto('/admin/settings'); const card = page.locator('#auto-update');
  await expect(card.getByRole('switch')).toBeDisabled(); await expect(card.getByRole('button', { name: 'Retry loading' })).toBeVisible({ timeout: 15000 });
  shared.readFail = ''; await card.getByRole('button', { name: 'Retry loading' }).click(); await expect(card.getByRole('switch')).toBeEnabled(); expect(shared.writes).toEqual([]);
});
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`read-only and accessibility (${width}, ${theme})`, async ({ page }) => {
  const shared = state(); await page.setViewportSize({ width, height: 900 }); await page.addInitScript(theme => localStorage.setItem('codex.theme', theme), theme);
  await fixture(page, shared, false); await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'Hosts', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
  await expect(page.getByText('Read only. Changing these settings requires')).toBeVisible();
  for (const control of await page.getByRole('switch').all()) await expect(control).toBeDisabled();
  await expect(page.getByLabel('Role checks')).toBeDisabled();
  await expect(page.getByLabel('Inactivity window (days)')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `test-results/settings-${width}-${theme}.png`, fullPage: true });
  expect(shared.writes).toEqual([]);
});

test('Activity retires tool-call URLs and never requests generic MCP history', async ({ page }, testInfo) => {
  const shared = state(); await fixture(page, shared);
  const calls: string[] = [];
  page.on('request', req => calls.push(new URL(req.url()).pathname));
  await page.goto('/admin/activity?type=tools');
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/activity$/);
  await expect(page.getByRole('button', { name: 'Tool calls', exact: true })).toHaveCount(0);
  await expect(page.getByText('No changes recorded', { exact: true })).toBeVisible();
  expect(calls).not.toContain('/admin/mcp/logs');
  for (const width of [320, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => localStorage.setItem('codex.theme', theme), theme);
    await page.reload();
    await expect(page.getByText('No changes recorded', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`activity-${width}-${theme}.png`), fullPage: true });
  }
});
