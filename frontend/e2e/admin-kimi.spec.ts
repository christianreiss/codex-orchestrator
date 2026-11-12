import { expect, test } from '@playwright/test';
import { fixture, installFixtures } from './admin-fixtures';

const now = new Date().toISOString();
const reset = new Date(Date.now() + 3600000).toISOString();

test('Kimi Code tab owns its native reference, version and effort', async ({ page }) => {
  await installFixtures(page);
  await page.goto('/admin/engines?engine=kimi#kimi-native-settings');
  await expect(page.getByRole('tab', { name: 'Kimi Code', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#kimi-defaults')).toContainText('Kimi Code');
  await expect(page.locator('#kimi-native-settings').getByRole('link', { name: /Kimi Code 2.5.3 settings/i })).toHaveAttribute('href', 'https://moonshotai.github.io/kimi-code/en/configuration/config-files.html');
  await expect(page.locator('#kimi-version-exact')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Kimi Code', exact: true }).getByText('Max', { exact: true })).toBeVisible();
});

test('Kimi gateway starts off and explains the explicit opt-in', async ({ page }) => {
  await installFixtures(page);
  await page.goto('/admin/api-keys#kimi-proxy');
  await expect(page.locator('#kimi-proxy')).toHaveAttribute('open', '');
  await expect(page.locator('#kimi-engine')).toContainText('off by default');
  await expect(page.locator('#kimi-engine')).toContainText('subscription-backed third-party gateway');
  await expect(page.locator('#exposed-apis').getByRole('row').filter({ hasText: '/kimi/v1' })).toContainText('/kimi/v1');
});

test('Kimi usage retains zero and all four independent windows', async ({ page }, info) => {
  await installFixtures(page, path => {
    if (path === '/admin/accounts') return { accounts: [{
      id: 99, engine: 'kimi', label: 'Kimi subscription', state: 'enabled', verification_state: 'verified',
      verification_reason: null, verification_checked_at: now, generation: 1, sessions: [],
      plan: { name: 'Kimi Code', source: 'kimi_userinfo', observed_at: now, stale: false },
      usage: { fetched_at: now, checked_at: now, stale: false, short_used_percent: 0, short_resets_at: reset,
        weekly_used_percent: 25, weekly_resets_at: reset, windows: [
          { kind: 'five_hour', used_percent: 0, resets_at: reset }, { kind: 'weekly', used_percent: 25, resets_at: reset },
          { kind: 'month_total', used_percent: 40, resets_at: reset }, { kind: 'month_code', used_percent: 18, resets_at: null },
        ] },
    }] };
    return undefined;
  });
  for (const [width, scheme] of [[1440, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/admin/dashboard');
    const usage = page.getByRole('group', { name: 'Kimi subscription Kimi Code usage' });
    await expect(usage.getByRole('meter')).toHaveCount(4);
    await expect(usage.getByRole('meter', { name: '5-hour window' })).toHaveAttribute('aria-valuenow', '0');
    await expect(usage).toContainText('Reset time unavailable');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#usage').screenshot({ path: info.outputPath(`kimi-${width}-${scheme}.png`) });
  }
});

test('Chatty reorders four engines with labeled controls', async ({ page }) => {
  let order = ['codex', 'claude', 'grok', 'kimi'];
  const writes: string[][] = [];
  await installFixtures(page, (path, body) => {
    if (path === '/admin/chatty/settings') {
      if (body) { order = (body as { engine_order: string[] }).engine_order; writes.push(order); }
      return { ...fixture(path), enabled: true, engine_order: order };
    }
    return undefined;
  });
  await page.goto('/admin/settings#chatty');
  await page.getByRole('button', { name: 'Move Kimi Code up', exact: true }).click();
  await expect.poll(() => writes).toEqual([['codex', 'claude', 'kimi', 'grok']]);
  await expect(page.getByRole('group', { name: 'Automatic priority' }).getByRole('listitem').nth(2)).toContainText('Kimi Code');
});


test('Kimi seeding uses a dedicated device login and complete canonical JSON', async ({ page }) => {
  await installFixtures(page);
  await page.goto('/admin/accounts');
  await page.getByRole('main').locator('header').getByRole('button', { name: 'Add account', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Kimi Code', exact: true }).click();
  const input = dialog.getByRole('textbox', { name: 'Kimi Code subscription login JSON', exact: true });
  const canonical = JSON.parse((await input.getAttribute('placeholder'))!);
  expect(canonical.kimi_code.scope).toBe('kimi-code');
  expect(canonical.kimi_code.refresh_token).toBeTruthy();
  expect(canonical.device_id).toMatch(/^[a-f0-9]{32}$/);
  expect(canonical.oauth_host).toBe('https://auth.kimi.com');
  await expect(dialog).toContainText('ckx login');
  await expect(dialog).toContainText('throwaway KIMI_CODE_HOME');
  await expect(dialog).toContainText('The server is the only refresher');
});
