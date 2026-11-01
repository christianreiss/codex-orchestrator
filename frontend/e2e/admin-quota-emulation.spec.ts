import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './admin-fixtures';

const policy = { unlimited: false, short_warn_percent: 85, long_warn_percent: 85, short_auto_resume: true, long_auto_resume: false };
const defaults = { enabled: false, window_hours: 5, action: 'suggest_pause', auto_resume: false };
async function setup(page: Page) {
  const saved: Record<string, typeof defaults> = {}, writes: Array<{ engine: string; body: Record<string, unknown> }> = [];
  await page.route('**/admin/**', async route => {
    const req = route.request();
    if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname;
    const match = path.match(/^\/admin\/quota-policy\/(codex|claude|grok)$/);
    if (match) {
      const engine = match[1]!;
      if (req.method() === 'PUT') { const body = req.postDataJSON(); writes.push({ engine, body }); saved[engine] = body.emulation; }
      return route.fulfill({ json: { defaults: policy, override: null, effective: policy, emulation: saved[engine] ?? defaults } });
    }
    if (path === '/admin/quota-mode') return route.fulfill({ json: { hard_fail: true, limit_percent: 95, week_partition: 'off', advice: { mode: 'off', high_usage_percent: 85, projected_usage_percent: 100, min_pressure_gap: 20, max_age_minutes: 30, remember_day: true } } });
    return route.fulfill({ json: fixture(path) });
  });
  return writes;
}

test('engine emulation defaults off, persists independently, and explains resume', async ({ page }) => {
  const writes = await setup(page);
  await page.goto('/admin/limits#quota-policy');
  const panel = page.locator('#quota-policy-codex');
  await expect(panel.getByRole('switch', { name: 'Enable when the provider has no native short window' })).not.toBeChecked();
  await expect(panel.getByRole('switch', { name: 'Server resume after reset' })).not.toBeChecked();
  await panel.getByRole('switch', { name: 'Enable when the provider has no native short window' }).click();
  await panel.getByRole('button', { name: 'Window duration' }).click();
  await page.getByRole('option', { name: '8 hours', exact: true }).click();
  await expect(panel).toContainText('4.76% of the weekly allowance');
  await panel.getByRole('button', { name: 'At the local limit' }).click();
  await page.getByRole('option', { name: 'Hard stop — block new work', exact: true }).click();
  await panel.getByRole('switch', { name: 'Server resume after reset' }).click();
  await panel.getByRole('button', { name: 'Save quota policy' }).click();
  await expect(panel).toContainText('Quota policy saved.');
  expect(writes[0]).toMatchObject({ engine: 'codex', body: { emulation: { enabled: true, window_hours: 8, action: 'hard_stop', auto_resume: true } } });
  await page.getByRole('tab', { name: 'Claude', exact: true }).click();
  await expect(page.locator('#quota-policy-claude').getByRole('switch', { name: 'Enable when the provider has no native short window' })).not.toBeChecked();
  await page.reload();
  await expect(page.locator('#quota-policy-codex').getByRole('switch', { name: 'Enable when the provider has no native short window' })).toBeChecked();
  const axe = await new AxeBuilder({ page }).include('#quota-policy').analyze();
  expect(axe.violations).toEqual([]);
});

test('emulation controls reflow and remain operable in light and dark at phone width', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/limits#quota-policy');
  const panel = page.locator('#quota-policy-codex');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
    await expect(panel.getByRole('switch', { name: 'Server resume after reset' })).toBeVisible();
    await panel.getByRole('button', { name: 'At the local limit' }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const axe = await new AxeBuilder({ page }).include('#quota-policy').analyze();
    expect(axe.violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`emulation-${theme}-390.png`), fullPage: true });
  }
});

test('held work keeps its reason on a failed retry and confirms the explicit retry request', async ({ page }) => {
  await setup(page);
  const original = (fixture('/admin/agent-messaging/messages').messages as Array<Record<string, unknown>>)[0]!;
  const message = { ...original, kind: 'request', work_kind: 'request', status: 'queued', accepted_at: null,
    last_error_code: 'quota_emulation_wait', expires_at: new Date(Date.now() + 86400000).toISOString(),
    quota_emulation_wait: { account_id: 1, native_session_id: 'fixture-native', reset_at: new Date().toISOString(), manual_resume: false } };
  let attempts = 0;
  await page.route('**/admin/agent-messaging/messages**', async route => {
    const req = route.request();
    if (!req.headers().accept?.includes('application/json')) return route.fallback();
    if (new URL(req.url()).pathname.endsWith('/quota-retry')) {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: 429, json: { status: 'error', message: 'Local budget is still exhausted' } });
      message.last_error_code = null;
      message.quota_emulation_wait.manual_resume = true;
      return route.fulfill({ json: { message_id: message.id, status: 'queued' } });
    }
    return route.fulfill({ json: { messages: [message] } });
  });
  await page.goto('/admin/agent-messaging?view=deliveries');
  await expect(page.getByText('Held by emulated quota', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Retry held work' }).click();
  await expect(page.getByRole('alert')).toContainText('Local budget is still exhausted');
  await expect(page.getByRole('button', { name: 'Retry held work' })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry held work' }).click();
  await expect(page.getByText('Retry requested — awaiting the original receiver')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry held work' })).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('Accounts and Overview identify emulated readings, including stale usage above 100%', async ({ page }) => {
  await setup(page);
  const a = { id: 1, label: 'Local budget account', engine: 'codex', state: 'enabled', verification_state: 'verified', verification_checked_at: null, sessions: [], quota_policy: policy,
    usage: { supported: true, fetched_at: new Date().toISOString(), stale: false, current_window: { period: "weekly", used_percent: 24, resets_at: null }, short_used_percent: null, short_resets_at: null, weekly_used_percent: 24, weekly_resets_at: null, weekly_limit_seconds: 604800 },
    quota_snapshot: { emulation: { ...defaults, enabled: true, window_hours: 8 }, short: { source: 'emulated', used_percent: 109, limit_seconds: 28800, resets_at: new Date(Date.now() + 3600000).toISOString(), status: 'stale' } } };
  await page.route('**/admin/accounts', async route => {
    if (!route.request().headers().accept?.includes('application/json')) return route.fallback();
    return route.fulfill({ json: { accounts: [a] } });
  });
  for (const engine of ['codex', 'claude', 'grok']) {
  a.engine = engine;
  await page.goto('/admin/accounts');
  await expect(page.getByText('Emulated 8h', { exact: true })).toBeVisible();
  await expect(page.getByText('109%', { exact: true })).toBeVisible();
  await expect(page.getByText('Emulated quota stale — work allowed', { exact: true })).toBeVisible();
  await page.goto('/admin/dashboard');
  await expect(page.getByText('Emulated 8-hour window', { exact: true })).toBeVisible();
  await expect(page.getByText('Emulated quota stale — work allowed', { exact: true })).toBeVisible();
  }
});
