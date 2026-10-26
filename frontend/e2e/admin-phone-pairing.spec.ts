import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installFixtures } from './admin-fixtures';
import { installOwnerUpdates } from './owner-stream';

const phone = (id: string, name = 'My phone') => ({ id, name, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), revoked_at: null });

test('phone pairing follows the exact receipt to live completion', async ({ page }, testInfo) => {
  const devices: ReturnType<typeof phone>[] = [];
  await installFixtures(page, path => path === '/admin/companion/devices' ? { devices, push_configured: true } : undefined);
  const emit = await installOwnerUpdates(page);
  await page.route('**/admin/companion/pairings', route => route.fulfill({ json: { qr: 'test-only-qr', device_id: 'expected-phone', expires_at: new Date(Date.now() + 300000).toISOString() } }));
  await page.goto('/admin/account#devices');
  await page.getByRole('button', { name: 'Pair Android device', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pair your phone' });
  await expect(dialog.getByRole('list', { name: 'Phone pairing progress' })).toBeVisible();
  await expect(dialog.getByText('Pairing code ready', { exact: false })).toContainText('(done)');
  await expect(dialog.getByText('Waiting for your phone.', { exact: false })).toBeVisible();
  devices.push(phone('unrelated', 'Another phone'));
  await emit('companion.devices.changed');
  await expect(page.getByRole('list', { name: 'Paired Android devices', includeHidden: true })).toContainText('Another phone');
  await expect(dialog.getByRole('img')).toBeVisible();
  await expect(dialog.getByText('Phone paired', { exact: false })).toContainText('(in progress)');
  await page.screenshot({ path: testInfo.outputPath('phone-waiting.png'), fullPage: true });
  devices.push(phone('expected-phone'));
  await emit('companion.devices.changed');
  await expect(dialog.getByRole('status')).toHaveText('My phone is paired and can access your account.');
  await expect(dialog.getByText('Phone paired', { exact: false })).toContainText('(done)');
  await expect(dialog.getByRole('img')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Copy pairing code' })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('phone-paired.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('My phone', { exact: true })).toBeVisible();
});

test('remint tracks only the newest code and offline status checking confirms success', async ({ page }) => {
  let round = 0;
  const devices: ReturnType<typeof phone>[] = [];
  await installFixtures(page, path => path === '/admin/companion/devices' ? { devices, push_configured: true } : undefined);
  await page.route('**/admin/companion/pairings', route => route.fulfill({ json: { qr: `test-qr-${++round}`, device_id: `phone-${round}`, expires_at: new Date(Date.now() + 300000).toISOString() } }));
  await page.goto('/admin/account#devices');
  await page.getByRole('button', { name: 'Pair Android device', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pair your phone' });
  await expect(dialog.getByText('Live updates are unavailable.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Generate a new code' }).click();
  await expect(dialog.getByRole('img')).toBeVisible();
  expect(round).toBe(2);
  devices.push(phone('phone-1', 'Earlier phone'));
  await dialog.getByRole('button', { name: 'Check status' }).click();
  await expect(dialog.getByText('Phone paired', { exact: false })).toContainText('(in progress)');
  devices.push(phone('phone-2', 'Current phone'));
  await dialog.getByRole('button', { name: 'Check status' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Current phone is paired and can access your account.');
});

test('creation progress, failure and recovery stay visible on a narrow screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await installFixtures(page);
  let release: (() => void) | undefined;
  let attempt = 0;
  await page.route('**/admin/companion/pairings', async route => {
    if (++attempt === 1) {
      await new Promise<void>(resolve => { release = resolve; });
      return route.fulfill({ status: 503, json: { status: 'error', message: 'Pairing temporarily unavailable' } });
    }
    return route.fulfill({ json: { qr: 'recovery-qr', device_id: 'recovery-phone', expires_at: new Date(Date.now() + 300000).toISOString() } });
  });
  await page.goto('/admin/account#devices');
  await page.getByRole('button', { name: 'Pair Android device', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pair your phone' });
  await expect(dialog.getByText('Creating your one-time pairing code…')).toBeVisible();
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await expect(dialog.getByRole('alert')).toContainText('Pairing temporarily unavailable');
  await expect(dialog.getByText('Could not create a code.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Generate a new code' }).click();
  await expect(dialog.getByRole('img')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('phone-pairing-320.png'), fullPage: true });
});
