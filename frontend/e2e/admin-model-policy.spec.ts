import { expect, test } from '@playwright/test';

test('each engine limits choices and restores saved older preferences', async ({ page }) => {
  const models = { codex: ['gpt-6-sol', 'gpt-6.1-sol'], claude: ['claude-opus-5', 'claude-opus-5-5'], grok: ['grok-4.6', 'grok-4.7'] };
  type Engine = keyof typeof models;
  const flags: Record<Engine, boolean> = { codex: false, claude: false, grok: false };
  const writes: string[] = [];
  await page.route('**/admin/**', async route => {
    const req = route.request();
    if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (data: unknown) => route.fulfill({ json: data });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'owner', roles: ['owner'] }, capabilities: ['admin.read', 'settings.read', 'settings.manage', 'content.read'] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: '2026-10-16T00:00:00Z' } });
    if (path === '/admin/ws/info') return json({ enabled: false });
    if (path === '/admin/engines/state') return json({ engines: Object.keys(models).map(engine => ({ engine, enabled: true })) });
    if (path === '/admin/chatty/status') return json({ visible: false, engines: [] });
    const policy = path.match(/^\/admin\/model-policy\/(codex|claude|grok)$/);
    if (policy) {
      const engine = policy[1] as Engine;
      if (req.method() === 'PUT') { flags[engine] = req.postDataJSON().latest_only; writes.push(engine); }
      const [old, current] = models[engine];
      return json({ engine, latest_only: flags[engine], latest_models: [current], replacements: { [old!]: current, [current!]: current } });
    }
    const defaults = path.match(/^\/admin\/model-defaults\/(codex|claude|grok)$/);
    if (defaults) {
      const engine = defaults[1] as Engine;
      const [old, current] = models[engine];
      return json({ engine, model: flags[engine] ? current : old, ...(flags[engine] ? { stored_model: old } : {}), reasoning_effort: 'high', catalog: (flags[engine] ? [current] : [old, current]).map(model => ({ model, persistent_efforts: ['low', 'high'], default_effort: 'high' })) });
    }
    if (/\/config$/.test(path)) return json({ status: 'missing', revision: null, settings: {} });
    return json({});
  });
  await page.goto('/admin/engines');
  for (const engine of Object.keys(models) as Engine[]) {
    const [old, current] = models[engine];
    const toggle = page.locator(`#${engine}-model-policy`).getByRole('switch', { name: 'Only current models' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    const picker = page.locator(`#${engine}-fleet-model`);
    await expect(picker).toContainText(current!);
    await picker.click();
    await expect(page.getByRole('option', { name: old!, exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: current!, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(picker).toContainText(old!);
  }
  expect(writes).toEqual(['codex', 'codex', 'claude', 'claude', 'grok', 'grok']);
});
