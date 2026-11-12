import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, opts: { manage?: boolean; fail?: boolean } = {}) {
  const manage = opts.manage ?? true;
  const settings = { enabled: false, engine_order: ['codex', 'claude', 'grok', 'kimi'], concurrency: 1, queue_limit: 4, steps: 6, timeout_seconds: 120 };
  const puts: Array<Record<string, unknown>> = [];
  await page.route('**/admin/**', route => {
    const req = route.request();
    if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'operator', roles: ['owner'] }, capabilities: ['admin.read', 'settings.read', ...(manage ? ['settings.manage', 'chatty.manage'] : [])] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: '2026-10-09T08:00:00Z', dismissed_at: null } });
    if (path === '/admin/ws/info') return json({ enabled: false });
    if (path === '/admin/chatty/settings') {
      if (req.method() === 'PUT') {
        const body = req.postDataJSON(); puts.push(body);
        if (opts.fail) return json({ status: 'error', message: 'Chatty store unavailable' }, 503);
        Object.assign(settings, body);
      }
      return json(settings);
    }
    return json({});
  });
  return { settings, puts };
}

test('Chatty settings save the switch, the priority and a validated concurrency', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/admin/settings#chatty');
  const area = page.locator('#chatty');
  const toggle = area.getByRole('switch', { name: 'Enable Chatty' });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(f.puts.at(-1)).toMatchObject({ enabled: true });
  await area.getByRole('button', { name: 'Automatic priority' }).click();
  await page.getByRole('option', { name: 'Claude → Grok → Codex → Kimi Code', exact: true }).click();
  await expect.poll(() => f.puts.at(-1)?.engine_order).toEqual(['claude', 'grok', 'codex', 'kimi']);
  const parallel = area.getByLabel('Parallel Chatty requests');
  const save = area.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeDisabled();
  await parallel.fill('3');
  await expect(save).toBeDisabled();
  await expect(area).toContainText('Enter 1 or 2.');
  await parallel.fill('2');
  await save.click();
  await expect.poll(() => f.puts.at(-1)?.concurrency).toBe(2);
});

test('a failed Chatty save is visible at the control and the switch keeps the server value', async ({ page }) => {
  await fixture(page, { fail: true });
  await page.goto('/admin/settings#chatty');
  const area = page.locator('#chatty');
  const toggle = area.getByRole('switch', { name: 'Enable Chatty' });
  await toggle.click();
  await expect(area).toContainText('Save failed: Chatty store unavailable');
  await expect(toggle).not.toBeChecked();
});

test('without chatty.manage the section names the missing permission instead of vanishing', async ({ page }) => {
  await fixture(page, { manage: false });
  await page.goto('/admin/settings#chatty');
  const area = page.locator('#chatty');
  await expect(area.getByRole('heading', { name: 'Chatty', exact: true })).toBeVisible();
  await expect(area).toContainText('chatty.manage');
  await expect(area.getByRole('switch')).toHaveCount(0);
});
