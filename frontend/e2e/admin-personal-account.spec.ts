import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installFixtures } from './admin-fixtures';

test('account mutations keep errors and safe drafts beside the task', async ({ page }) => {
  await installFixtures(page);
  let fail = true;
  await page.route('**/admin/auth/password/change', route => route.fulfill({
    status: fail ? 400 : 200,
    json: fail ? { status: 'error', message: 'Current password is incorrect' } : { status: 'ok', data: {} },
  }));
  await page.goto('/admin/account#security');
  await page.locator('summary').click();
  await page.getByLabel('Current password', { exact: true }).fill('old-password');
  await page.getByLabel('New password', { exact: true }).fill('New-password-123');
  await page.getByLabel('Confirm new password', { exact: true }).fill('New-password-123');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText('Current password is incorrect', { exact: true })).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveValue('New-password-123');
  fail = false;
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Password changed.' })).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveValue('');

  await page.route('**/admin/theme', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { status: 'error', message: 'Appearance storage unavailable' } })
    : route.fallback());
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await page.getByRole('radio', { name: /Dark/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Appearance storage unavailable' })).toBeVisible();
  await expect(page.getByText('Preview applied on this device;', { exact: false })).toBeVisible();
});

test('devices distinguish empty, failed loading and failed actions', async ({ page }) => {
  await installFixtures(page);
  await page.route('**/admin/companion/devices', route => route.fulfill({ json: { devices: [], push_configured: true } }));
  await page.goto('/admin/account#devices');
  await expect(page.getByText('No paired devices yet', { exact: true })).toBeVisible();
  await page.route('**/admin/companion/pairings', route => route.fulfill({ status: 503, json: { status: 'error', message: 'Pairing unavailable' } }));
  await page.getByRole('button', { name: 'Pair Android device', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Pairing unavailable' })).toBeVisible();
  await page.route('**/admin/companion/devices', route => route.fulfill({ status: 503, json: { status: 'error', message: 'Device list unavailable' } }));
  await page.reload();
  await expect(page.getByText('Device list unavailable', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('No paired devices yet', { exact: true })).not.toBeVisible();
});

test('expired pairing codes disappear and cannot be copied', async ({ page }) => {
  await installFixtures(page);
  await page.route('**/admin/companion/pairings', route => route.fulfill({ json: { qr: 'test-only-expired-pairing', expires_at: new Date(Date.now() - 1000).toISOString() } }));
  await page.goto('/admin/account#devices');
  await page.getByRole('button', { name: 'Pair Android device', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pair your phone' });
  await expect(dialog.getByText('Code expired', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('img')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Copy pairing code' })).toBeDisabled();
});

for (const theme of ['light', 'dark', 'system'] as const) {
  test(`personal account tabs reflow and remain accessible in ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await installFixtures(page, path => {
      if (path === '/admin/theme') return { theme: theme === 'system' ? 'auto' : theme };
      if (path === '/admin/companion/devices') return { push_configured: true, devices: [
        { id: 'phone', name: 'Personal Android phone with a deliberately long device name', created_at: '2026-10-25T12:00:00Z', last_seen_at: '2026-10-26T06:00:00Z', revoked_at: null },
        { id: 'old', name: 'Previous tablet', created_at: '2026-10-20T12:00:00Z', last_seen_at: null, revoked_at: '2026-10-25T12:00:00Z' },
      ] };
      return undefined;
    });
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' });
    await page.addInitScript(value => localStorage.setItem('codex.theme', value), theme);
    await page.goto('/admin/account');
    for (const width of [320, 390, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 768 ? 1024 : width >= 1440 ? 900 : 844 });
      for (const tab of ['Profile', 'Security', 'Appearance', 'Devices']) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        await expect(page.getByRole('tabpanel')).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 320) {
          const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
          expect(results.violations).toEqual([]);
        }
        if ((width === 1440 && theme === 'light') || (width === 390 && theme === 'dark')) {
          await page.screenshot({ path: testInfo.outputPath(`${tab}-${theme}-${width}.png`), fullPage: true });
        }
      }
    }
  });
}

test('passkey rename drafts survive tabs and report failures; removal stays scoped', async ({ page }) => {
  let name = 'Operator laptop';
  let removed = false;
  let fail = true;
  await installFixtures(page, path => path === '/admin/passkeys' ? { passkeys: removed ? [] : [{ id: 1, name, created_at: '2026-10-25T12:00:00Z', last_used_at: null }] } : undefined);
  await page.route('**/admin/passkeys/1/name', route => {
    if (fail) return route.fulfill({ status: 503, json: { status: 'error', message: 'Rename unavailable' } });
    name = route.request().postDataJSON().name;
    return route.fulfill({ json: {} });
  });
  await page.route('**/admin/passkeys/1', route => { removed = true; return route.fulfill({ json: {} }); });
  await page.goto('/admin/account#security');
  await page.getByRole('button', { name: 'Actions for Operator laptop', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Passkey name', exact: true }).fill('My security key');
  await page.getByRole('tab', { name: 'Devices', exact: true }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Passkey name', exact: true })).toHaveValue('My security key');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Rename unavailable' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('My security key', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for My security key', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove passkey?' });
  await expect(dialog).toContainText('My security key');
  await dialog.getByRole('button', { name: 'Remove passkey', exact: true }).click();
  await expect(page.getByText('No passkeys registered', { exact: true })).toBeVisible();
});


test('failed device revocation preserves the device and a visible failure', async ({ page }) => {
  await installFixtures(page, path => path === '/admin/companion/devices' ? { push_configured: true, devices: [
    { id: 'phone', name: 'Personal phone', created_at: '2026-10-25T12:00:00Z', last_seen_at: null, revoked_at: null },
  ] } : undefined);
  await page.route('**/admin/companion/devices/phone', route => route.fulfill({ status: 503, json: { status: 'error', message: 'Could not confirm revocation' } }));
  await page.goto('/admin/account#devices');
  await expect(page.getByText('Never connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke Personal phone', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Revoke device', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not confirm revocation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke Personal phone', exact: true })).toBeVisible();
  await expect(page.getByText('Paired', { exact: true })).toBeVisible();
});
