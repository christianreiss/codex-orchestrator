import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
function state() {
  return { values: {
    'auto-update': { enabled: false }, 'reverse-dns': { enabled: true },
    'api-keys-in-chat': { enabled: true }, 'remote-exec': { enabled: false }, 'insecure-approval': { enabled: false },
    authorization: { mode: 'compatible', updated_at: null, would_deny: [{ role: 'operator', capability: 'security.manage_authorization', route: 'POST /admin/authorization', first_seen: '2026-10-09T08:00:00Z', last_seen: '2026-10-09T08:00:00Z' }] },
    'prune-policy': { inactivity_window_days: 30 },
    'log-retention': { enabled: false, days_logs: 90, days_mcp: 90, days_events: 30, days_graph_stats: 180 },
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
    if (path === '/admin/ws/info') return json({ enabled: true, url: 'ws://127.0.0.1:4173/policies-ws' });
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
async function category(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1280) < 1024) await page.getByLabel('Policy category').selectOption({ label: name });
  else await page.getByRole('navigation', { name: 'Policy categories' }).getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
test('categories preserve drafts and old anchors without duplicate IDs', async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto('/admin/policies');
  await expect(page.getByRole('heading', { name: 'Host behavior', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Log retention', exact: true })).not.toBeVisible();
  await category(page, 'Cleanup'); const days = page.getByLabel('Inactivity window (days)');
  await expect(days).toHaveValue('30'); await days.fill('12');
  await category(page, 'Agent behavior'); await category(page, 'Cleanup'); await expect(days).toHaveValue('12');
  await page.locator('#prune-policy').getByRole('button', { name: 'Reset', exact: true }).click(); await expect(days).toHaveValue('30');
  for (const [anchor, name] of [['authorization', 'Access control'], ['insecure-approval', 'Access control'], ['host-lifecycle', 'Cleanup'], ['prune-policy', 'Cleanup'], ['log-retention', 'Cleanup'], ['remote-exec', 'Agent behavior'], ['auto-update', 'Host behavior']]) {
    await page.goto(`/admin/policies#${anchor}`); await expect(page.getByRole('heading', { name, exact: true })).toBeVisible(); await expect(page.locator(`#${anchor}`)).toBeVisible();
  }
  expect(shared.writes).toEqual([]);
  expect(await page.locator('[id]').evaluateAll(nodes => { const ids = nodes.map(n => n.id); return ids.filter((id, i) => ids.indexOf(id) !== i); })).toEqual([]);
});
test('immediate controls save, reload and recover after failure', async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto('/admin/policies');
  const toggle = page.getByRole('switch', { name: 'Enable automatic updates', exact: true });
  await expect(toggle).toBeEnabled(); shared.fail = 'auto-update'; await toggle.click();
  await expect(page.locator('#auto-update')).toContainText('Save failed'); await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
  shared.fail = ''; await toggle.click(); await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
  await category(page, 'Agent behavior'); await page.getByRole('switch', { name: 'Enable remote execution', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Enable remote execution', exact: true })).toBeChecked();
  await category(page, 'Access control'); const mode = page.getByLabel('Authorization mode');
  shared.fail = 'authorization'; await mode.selectOption('strict'); await expect(page.locator('#authorization')).toContainText('Save failed'); await expect(mode).toHaveValue('compatible'); await expect(mode).toBeEnabled();
  shared.fail = ''; await mode.selectOption('strict'); await expect(mode).toHaveValue('strict'); await expect(mode).toBeEnabled();
  await page.getByRole('switch', { name: 'Enable approval requests', exact: true }).click(); await expect(page.getByRole('switch', { name: 'Enable approval requests', exact: true })).toBeChecked();
  await page.reload(); await expect(mode).toHaveValue('strict');
});
test('numeric validation and retention toggle never submit unsaved durations', async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto('/admin/policies#cleanup');
  const prune = page.locator('#prune-policy'), retention = page.locator('#log-retention');
  const days = prune.getByLabel('Inactivity window (days)'), save = prune.getByRole('button', { name: 'Save changes' });
  await expect(days).toHaveValue('30'); await expect(save).toBeDisabled();
  for (const value of ['1.5', '-1', '61', '']) { await days.fill(value); await expect(save).toBeDisabled(); await expect(days).toHaveAttribute('aria-invalid', 'true'); }
  await days.fill('0'); await save.click(); await expect(prune).toContainText('inactivity pruning disabled'); await expect(save).toBeDisabled();
  const logs = retention.getByLabel('API logs (days)'); await logs.fill('45');
  const toggle = retention.getByRole('switch', { name: 'Enable automatic log removal' }); await toggle.click(); await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled(); await expect(logs).toHaveValue('45');
  expect(shared.values['log-retention'].days_logs).toBe(90); expect(shared.writes.at(-1)?.body.days_logs).toBe(90);
  await logs.fill('366'); await expect(retention.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await logs.fill('45'); shared.fail = 'log-retention'; await retention.getByRole('button', { name: 'Save changes' }).click();
  await expect(retention).toContainText('Save failed'); await expect(logs).toHaveValue('45');
  shared.fail = ''; await retention.getByRole('button', { name: 'Save changes' }).click(); await expect(retention.getByRole('button', { name: 'Save changes' })).toBeDisabled(); await expect.poll(() => shared.values['log-retention'].days_logs).toBe(45);
});
test('external updates refresh pristine values and protect dirty drafts', async ({ page }) => {
  const shared = state(); const refresh = await fixture(page, shared); await page.goto('/admin/policies#cleanup');
  const prune = page.locator('#prune-policy'), days = prune.getByLabel('Inactivity window (days)');
  await expect(days).toHaveValue('30'); shared.values['prune-policy'].inactivity_window_days = 20; await refresh(); await expect(days).toHaveValue('20');
  await days.fill('12'); shared.values['prune-policy'].inactivity_window_days = 40; await refresh();
  await expect(prune).toContainText('Saved values changed elsewhere'); await expect(days).toHaveValue('12'); await expect(prune.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await prune.getByRole('button', { name: 'Reset', exact: true }).click(); await expect(days).toHaveValue('40');
  const retention = page.locator('#log-retention'), logs = retention.getByLabel('API logs (days)');
  await logs.fill('14'); shared.values['log-retention'].days_logs = 60; await refresh(); await expect(retention).toContainText('Saved values changed elsewhere'); await expect(logs).toHaveValue('14');
  await retention.getByRole('button', { name: 'Reset', exact: true }).click(); await expect(logs).toHaveValue('60');
});
test('failed reads disable writes and offer retry', async ({ page }) => {
  const shared = state(); shared.readFail = 'auto-update'; await fixture(page, shared); await page.goto('/admin/policies'); const card = page.locator('#auto-update');
  await expect(card.getByRole('switch')).toBeDisabled(); await expect(card.getByRole('button', { name: 'Retry loading' })).toBeVisible({ timeout: 15000 });
  shared.readFail = ''; await card.getByRole('button', { name: 'Retry loading' }).click(); await expect(card.getByRole('switch')).toBeEnabled(); expect(shared.writes).toEqual([]);
});
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`read-only, keyboard and accessibility (${width}, ${theme})`, async ({ page }) => {
  const shared = state(); await page.setViewportSize({ width, height: 900 }); await page.addInitScript(theme => localStorage.setItem('codex.theme', theme), theme);
  await fixture(page, shared, false); await page.goto('/admin/policies');
  await expect(page.getByRole('heading', { name: 'Host behavior', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
  for (const name of ['Host behavior', 'Agent behavior', 'Access control', 'Cleanup']) {
    await category(page, name);
    for (const control of await page.getByRole('switch').all()) if (await control.isVisible()) await expect(control).toBeDisabled();
    if (name === 'Access control') await expect(page.getByLabel('Authorization mode')).toBeDisabled();
    if (name === 'Cleanup') await expect(page.getByLabel('Inactivity window (days)')).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `test-results/policies-${width}-${theme}-${name.toLowerCase().replaceAll(' ', '-')}.png`, fullPage: true });
  }
  if (width < 1024) { await page.getByLabel('Policy category').focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter'); }
  else { await page.getByRole('navigation', { name: 'Policy categories' }).getByRole('link', { name: /Access control/ }).focus(); await page.keyboard.press('Enter'); }
  await expect(page.getByRole('heading', { name: 'Access control', exact: true })).toBeVisible();
  expect(shared.writes).toEqual([]);
});
