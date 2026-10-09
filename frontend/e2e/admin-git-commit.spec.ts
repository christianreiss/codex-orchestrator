import { expect, test, type Page } from '@playwright/test';

type Settings = { message_style: 'short' | 'long'; ai_attribution: boolean };
function state() {
  return { settings: { message_style: 'short', ai_attribution: false } as Settings, writes: [] as Settings[], fail: false };
}
async function fixture(page: Page, shared: ReturnType<typeof state>, manage = true) {
  let emit: ((data: string) => void) | undefined;
  await page.routeWebSocket('**/commit-ws', (ws) => { emit = (data) => ws.send(data); });
  await page.route('**/admin/**', (route) => {
    const req = route.request();
    if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true,
      user: { id: 1, username: 'operator', roles: [manage ? 'owner' : 'viewer'] },
      capabilities: ['admin.read', 'git_director.read', ...(manage ? ['git_director.manage'] : [])] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true,
      checks: [], next_actions: [], wizard: { completed_at: '2026-10-09T08:00:00Z', dismissed_at: null } });
    if (path === '/admin/ws/info') return json({ enabled: true, url: 'ws://127.0.0.1:4173/commit-ws' });
    if (path === '/admin/git-director/state') return json({ enabled: false, model: 'test', clones: 0, worktrees: 0, updated_at: null });
    if (path === '/admin/git-director') return json({ clones: [] });
    if (path === '/admin/git-director/commit-settings') {
      if (req.method() === 'POST') {
        const payload = req.postDataJSON() as Settings;
        shared.writes.push(payload);
        if (shared.fail) return json({ status: 'error', message: 'Save failed' }, 503);
        shared.settings = payload;
      }
      return json({ status: 'ok', data: shared.settings });
    }
    return json({});
  });
  return async () => {
    await expect.poll(() => Boolean(emit)).toBe(true);
    emit!(JSON.stringify({ type: 'settings.changed', payload: { key: 'git_commit_settings' }, ts: new Date().toISOString() }));
  };
}

test('saves all combinations and previews each engine with the Director disabled', async ({ page }) => {
  const shared = state();
  await fixture(page, shared);
  await page.goto('/admin/git-director');
  const card = page.locator('#git-commit-messages');
  const style = card.getByLabel('Message length');
  const attribution = card.getByRole('switch', { name: 'AI Attribution', exact: true });
  await expect(style).toHaveValue('short');
  await expect(attribution).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Enable the Git Director' })).not.toBeChecked();
  for (const message_style of ['long', 'short'] as const) {
    await style.selectOption(message_style);
    await expect(style).toHaveValue(message_style);
    await expect(style).toBeEnabled();
    for (const ai_attribution of [true, false]) {
      await attribution.click();
      await expect(attribution).toBeChecked({ checked: ai_attribution });
      await expect(attribution).toBeEnabled();
      for (const engine of ['Codex', 'Claude', 'Grok']) {
        const preview = card.getByText(`${engine} preview`, { exact: true }).locator('..').locator('pre');
        await expect(preview).toHaveText('Fix stale host status'
          + (message_style === 'long' ? '\n\nRefresh host status after configuration changes so the dashboard shows the current state.' : '')
          + (ai_attribution ? `\n\nAI-Assisted-By: ${engine}` : ''), { useInnerText: true });
      }
    }
  }
  expect(shared.writes).toContainEqual({ message_style: 'long', ai_attribution: true });
  expect(shared.writes).toContainEqual({ message_style: 'short', ai_attribution: false });
  await page.reload();
  await expect(style).toHaveValue('short');
  await expect(attribution).not.toBeChecked();
});

test('failed saves restore controls; another tab receives settings updates', async ({ page, context }) => {
  const shared = state();
  await fixture(page, shared);
  const other = await context.newPage();
  const refreshOther = await fixture(other, shared);
  await page.goto('/admin/git-director');
  const style = page.getByLabel('Message length');
  await expect(style).toBeEnabled();
  await other.goto('/admin/git-director');
  await expect(other.getByLabel('Message length')).toBeEnabled();
  shared.fail = true;
  await style.selectOption('long');
  await expect(page.locator('#git-commit-messages')).toContainText('Save failed');
  await expect(style).toHaveValue('short');
  await expect(style).toBeEnabled();
  await page.getByRole('switch', { name: 'AI Attribution', exact: true }).click();
  await expect.poll(() => shared.writes.length).toBe(2);
  await expect(page.getByRole('switch', { name: 'AI Attribution', exact: true })).not.toBeChecked();
  shared.fail = false;
  await expect(style).toBeEnabled();
  await style.selectOption('long');
  await expect(style).toHaveValue('long');
  await refreshOther();
  await expect(other.getByLabel('Message length')).toHaveValue('long');
});

test('read-only users see disabled settings and previews on mobile', async ({ page }) => {
  const shared = state();
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, shared, false);
  await page.goto('/admin/git-director');
  await expect(page.getByLabel('Message length')).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'AI Attribution', exact: true })).toBeDisabled();
  await expect(page.getByText('Grok preview', { exact: true })).toBeVisible();
  expect(shared.writes).toEqual([]);
});
