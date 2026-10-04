import { expect, test } from '@playwright/test';

test('pairs and revokes an Android device from Account', async ({ page }) => {
  const devices = [{ id: 'c9d58569-a10f-49e4-b331-9e1633a84176', name: 'Pixel test', created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), revoked_at: null as string | null }];
  let paired = 0;
  await page.route('**/admin/**', async route => {
    if (route.request().resourceType() === 'document') return route.continue();
    const path = new URL(route.request().url()).pathname;
    if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.continue();
    let data: unknown = {};
    if (path === '/admin/auth/status') data = { authenticated: true, enforced: true, user: { id: 1, name: 'Operator', username: 'operator', access_level: 'owner' }, roles: ['owner'], capabilities: ['account.self_manage'] };
    else if (path === '/admin/setup/status') data = { setup_complete: true, next_actions: [], checks: [], critical_complete: true, wizard: { completed_at: new Date().toISOString() } };
    else if (path === '/admin/ws/info') data = { enabled: false };
    else if (path === '/admin/companion/devices') data = { devices, push_configured: false };
    else if (path === '/admin/companion/pairings') { paired++; data = { qr: JSON.stringify({ version: 1, server: 'https://fleet.example', token: 'a'.repeat(64) }), expires_at: new Date(Date.now() + 300000).toISOString() }; }
    else if (path.startsWith('/admin/companion/devices/') && route.request().method() === 'DELETE') devices[0].revoked_at = new Date().toISOString();
    await route.fulfill({ json: { status: 'ok', data } });
  });
  await page.goto('/admin/account/devices');
  await expect(page.getByRole('heading', { name: 'Android devices', exact: true })).toBeVisible();
  await expect(page.getByText('Push delivery is not configured.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Pair Android device', exact: true }).click();
  await expect(page.getByRole('img', { name: 'One-time Android pairing QR code' })).toBeVisible();
  expect(paired).toBe(1);
  await page.screenshot({ path: 'test-results/companion-pairing.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
});
