import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

type State = { enabled: boolean; writes: boolean[]; fail: 'none' | 'rejected' | 'persisted'; readFails: boolean; hold?: Promise<void> };
async function fixture(page: Page, state: State, manage = true, read = true) {
  await page.route('**/admin/**', async route => {
    const request = route.request();
    if (!request.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'operator', roles: ['viewer'] }, capabilities: ['admin.read', 'settings.read', ...(read ? ['agent_messaging.read'] : []), ...(manage ? ['agent_messaging.manage'] : [])] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: '2026-10-21T08:00:00Z', dismissed_at: null } });
    if (path === '/admin/ws/info') return json({ enabled: false });
    if (path === '/admin/agent-messaging/scopes/state') {
      if (request.method() === 'POST') {
        const enabled = request.postDataJSON().enabled;
        state.writes.push(enabled);
        await state.hold;
        if (state.fail !== 'rejected') state.enabled = enabled;
        if (state.fail !== 'none') return json({ status: 'error', message: 'Save response unavailable' }, 500);
      } else if (state.readFails) return json({ status: 'error', message: 'State unavailable' }, 503);
      return json({ enabled: state.enabled, protocol: 1, shell_enforcement: false });
    }
    if (path === '/admin/overview') return json({ inactivity_window_days: 30 });
    return json({});
  });
}
function state(): State { return { enabled: false, writes: [], fail: 'none', readFails: false }; }
function section(page: Page) { return page.locator('#agent-coordination'); }

test('coordination has one discoverable editable home, immediate confirmation and reload persistence', async ({ page }) => {
  const shared = state();
  let release!: () => void;
  shared.hold = new Promise<void>(resolve => { release = resolve; });
  await fixture(page, shared);
  await page.goto('/admin/settings#agent-coordination');
  const area = section(page), toggle = area.getByRole('switch', { name: 'Enable agent coordination' });
  await expect(area.getByRole('heading', { name: 'Agent coordination', exact: true })).toBeVisible();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(area).toContainText('Saving… Waiting for server confirmation.');
  await expect(toggle).toBeDisabled();
  await expect(area).toContainText('Effective state: Disabled');
  release();
  await expect(area).toContainText('Saved. Confirmed by the server.');
  await expect(toggle).toBeChecked();
  expect(shared.writes).toEqual([true]);
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(area).toContainText('Effective state: Enabled');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search fleet or run a command…').fill('resource claims');
  await expect(page.getByRole('option', { name: /Settings \/ Agent coordination/ })).toBeVisible();
});

test('a failed response after persistence reconciles without a repeat write', async ({ page }) => {
  const shared = state(); shared.fail = 'persisted';
  await fixture(page, shared); await page.goto('/admin/settings#agent-coordination');
  const area = section(page), toggle = area.getByRole('switch', { name: 'Enable agent coordination' });
  await expect(toggle).toBeEnabled(); await toggle.click();
  await expect(area).toContainText('fresh server read confirmed the requested state');
  await expect(area).toContainText('Saved. Confirmed by the server.');
  await expect(toggle).toBeChecked(); expect(shared.writes).toEqual([true]);
});

test('rejected saves retain the request and check state before retrying', async ({ page }) => {
  const shared = state(); shared.fail = 'rejected';
  await fixture(page, shared); await page.goto('/admin/settings#agent-coordination');
  const area = section(page), toggle = area.getByRole('switch', { name: 'Enable agent coordination' });
  await expect(toggle).toBeEnabled(); await toggle.click();
  await expect(area.getByRole('alert')).toContainText('Save response unavailable');
  await expect(area).toContainText('Requested state: Enabled');
  await expect(area).toContainText('Effective state: Disabled');
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  shared.fail = 'none';
  await area.getByRole('button', { name: 'Check state and retry' }).click();
  await expect(area).toContainText('Saved. Confirmed by the server.');
  await expect(toggle).toBeChecked(); expect(shared.writes).toEqual([true, true]);
});

test('failed reconciliation never repeats a possibly accepted write', async ({ page }) => {
  const shared = state(); shared.fail = 'persisted';
  await fixture(page, shared); await page.goto('/admin/settings#agent-coordination');
  const area = section(page), toggle = area.getByRole('switch', { name: 'Enable agent coordination' });
  await expect(toggle).toBeEnabled(); shared.readFails = true; await toggle.click();
  await expect(area).toContainText('Current server state is unconfirmed.');
  await expect(area).toContainText('displayed state is stale');
  await area.getByRole('button', { name: 'Check state and retry' }).click();
  await expect(area).toContainText('Current server state is unconfirmed.');
  expect(shared.writes).toEqual([true]);
  shared.readFails = false;
  await area.getByRole('button', { name: 'Check state and retry' }).click();
  await expect(toggle).toBeChecked(); await expect(area).toContainText('Saved. Confirmed by the server.');
  expect(shared.writes).toEqual([true]);
});

test('initial loading failures offer a safe read retry and permission denial never exposes a switch', async ({ page }) => {
  const shared = state(); shared.readFails = true;
  await fixture(page, shared); await page.goto('/admin/settings#agent-coordination');
  const area = section(page);
  await expect(area).toContainText('Could not load agent coordination.');
  await expect(area.getByRole('switch')).toHaveCount(0);
  shared.readFails = false; await area.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(area.getByRole('switch')).toBeEnabled();
  await fixture(page, shared, false, false); await page.reload();
  await expect(area).toContainText('Viewing this setting requires');
  await expect(area.getByRole('switch')).toHaveCount(0); expect(shared.writes).toEqual([]);
});

for (const width of [320, 390, 768, 1440, 1920]) for (const theme of ['light', 'dark']) test(`coordination read-only reflow and accessible labels (${width}, ${theme})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(mode => localStorage.setItem('codex.theme', mode), theme);
  const shared = state(); shared.enabled = true;
  await fixture(page, shared, false); await page.goto('/admin/settings#agent-coordination');
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
  const area = section(page), toggle = area.getByRole('switch', { name: 'Enable agent coordination' });
  await expect(toggle).toBeChecked(); await expect(toggle).toBeDisabled();
  await expect(area).toContainText('Changes require');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).include('#agent-coordination').analyze();
  expect(results.violations).toEqual([]);
  await area.screenshot({ path: `test-results/coordination-${width}-${theme}.png` });
  expect(shared.writes).toEqual([]);
});

test.describe('touch and system appearance', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  test('uses system appearance and accessible touch targets with keyboard saving', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('codex.theme', 'system'));
    const shared = state(); await fixture(page, shared);
    await page.goto('/admin/settings#agent-coordination');
    await expect(page.locator('html')).toHaveClass(/dark/);
    const area = section(page), toggle = area.getByRole('switch', { name: 'Enable agent coordination' });
    await expect(toggle).toBeEnabled();
    const bounds = await toggle.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    await toggle.focus(); await page.keyboard.press('Space');
    await expect(area).toContainText('Saved. Confirmed by the server.');
    await expect(toggle).toBeChecked(); expect(shared.writes).toEqual([true]);
  });
});
