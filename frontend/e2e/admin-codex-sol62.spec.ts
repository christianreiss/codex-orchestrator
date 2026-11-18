import { expect, test } from '@playwright/test';

for (const width of [320, 1440]) test(`Codex Sol 6.2 uses its native default and persists explicit Ultra (${width}px)`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const catalog = [
    { model: 'gpt-6.2-sol', persistent_efforts: efforts, default_effort: 'low' },
    { model: 'gpt-6.1-sol', persistent_efforts: efforts, default_effort: 'low' },
    { model: 'gpt-6-sol', persistent_efforts: efforts, default_effort: 'medium' },
  ];
  let selected = { model: 'gpt-6.1-sol', reasoning_effort: 'low' };
  const writes: unknown[] = [];
  await page.route('**/admin/**', route => {
    const req = route.request();
    if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (data: unknown) => route.fulfill({ json: data });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'owner', roles: ['owner'] }, capabilities: ['admin.read', 'settings.read', 'settings.manage', 'content.read'] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: '2026-10-26T00:00:00Z' } });
    if (path === '/admin/ws/info') return json({ enabled: false });
    if (path === '/admin/engines/state') return json({ engines: ['codex', 'claude', 'grok', 'kimi'].map(engine => ({ engine, label: engine, enabled: true, assigned_hosts: 0, updated_at: null, updated_by: null })) });
    if (path === '/admin/chatty/status') return json({ visible: false, engines: [] });
    if (path === '/admin/model-defaults/codex') {
      if (req.method() === 'POST') { selected = req.postDataJSON(); writes.push(selected); }
      return json({ engine: 'codex', ...selected, catalog });
    }
    if (path === '/admin/model-policy/codex') return json({ engine: 'codex', latest_only: false, latest_models: ['gpt-6.2-sol'], replacements: { 'gpt-6.1-sol': 'gpt-6.2-sol' } });
    if (/\/config$/.test(path)) return json({ status: 'missing', revision: null, settings: {} });
    return json({});
  });
  await page.goto('/admin/engines?engine=codex');
  const region = page.getByRole('region', { name: 'Codex', exact: true });
  const sol = region.getByRole('radio', { name: 'GPT-6.2 Sol', exact: true });
  await expect(sol).toBeEnabled(); await sol.check({ force: true });
  await expect.poll(() => selected).toEqual({ model: 'gpt-6.2-sol', reasoning_effort: 'low' });
  await expect(region.locator('input[name="codex-quick-effort"][value="low"]')).toBeChecked();
  await region.locator('input[name="codex-quick-effort"][value="ultra"]').check({ force: true });
  await expect.poll(() => selected.reasoning_effort).toBe('ultra');
  await page.reload(); await expect(sol).toBeChecked();
  await expect(region.locator('input[name="codex-quick-effort"][value="ultra"]')).toBeChecked();
  await expect(region.getByRole('radio', { name: 'GPT-6.1 Sol', exact: true })).toBeEnabled();
  await expect(region.getByRole('radio', { name: 'GPT-6 Sol', exact: true })).toBeEnabled();
  expect(writes).toEqual([{ model: 'gpt-6.2-sol', reasoning_effort: 'low' }, { model: 'gpt-6.2-sol', reasoning_effort: 'ultra' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await sol.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath(`sol62-${width}.png`), fullPage: true });
});
