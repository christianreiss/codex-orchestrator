import { ownerStream } from "./owner-stream";
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function fixture(page: Page, overrides = false, manage = true, singleEngine = false, authed = true) {
  const stamp = new Date().toISOString();
  const host = {
    presence: 'online', presence_heartbeat_at: stamp, presence_observed_at: stamp, presence_fresh_seconds: 45, last_contact_at: stamp,
    id: 1, fqdn: 'workstation.example.test', secure: true, status: 'active', authed,
    engines: singleEngine ? 'codex' : 'codex,claude,grok', engines_list: singleEngine ? ['codex'] : ['codex', 'claude', 'grok'],
    ip4: '192.0.2.10', ip6: '2001:db8::10', last_refresh: stamp, last_cron_check: stamp,
    updated_at: stamp, users: [], api_calls: 42, client_version: '1.2.3', claude_client_version: '2.3.4',
    grok_client_version: '1.0.50', model_override: overrides ? 'gpt-6.1-sol' : null,
    effective_auto_update_enabled: true, reverse_dns_mode: 'global',
  };
  let daemon = { host_id: 1, enabled: true, username: 'chris', default_cwd: '', max_parallel: 8, idle_minutes: 60, question_minutes: 1440,
    access: { secure: true, allowed: true }, health: { state: 'green', reasons: [], heartbeat_at: stamp, used_slots: 0, max_slots: 8 }, sessions: [] };
  const writes: { path: string; value: any }[] = [];
  await page.routeWebSocket('**/host-detail-ws', ws => { ownerStream(ws); });
  await page.route('**/admin/**', route => {
    const req = route.request();
    if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (data: unknown) => route.fulfill({ json: { status: 'ok', data } });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'operator', roles: [manage ? 'owner' : 'viewer'] }, capabilities: ['admin.read', 'hosts.read', 'settings.read', ...(manage ? ['hosts.manage', 'agent_messaging.manage'] : [])] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: stamp } });
    if (path === '/admin/ws/info') return json({ enabled: true, url: 'ws://127.0.0.1:4173/host-detail-ws' });
    if (path === '/admin/hosts/1/detail') return json({ host });
    if (path === '/admin/engines/state') return json({ engines: ['codex', 'claude', 'grok'].map(engine => ({ engine, enabled: engine !== 'grok' })) });
    if (path === '/admin/model-defaults/grok') return json({ model: 'grok-4.7', catalog: [] });
    if (path === '/admin/hosts/1/installer') {
      writes.push({ path, value: req.postDataJSON() });
      return json({ installer: { token: 't', mode: 'both', label: 'Codex + Claude installer', url: 'https://orchestrator.example.test/install/t', command: 'curl -fsSL https://orchestrator.example.test/install/t | sh', expires_at: new Date(Date.now() + 3_600_000).toISOString() } });
    }
    if (path === '/admin/hosts/1/daemon') {
      if (req.method() !== 'GET') { const value = req.postDataJSON(); writes.push({ path, value }); daemon = { ...daemon, ...value }; }
      return json(daemon);
    }
    if (path === '/admin/host-daemons') return json({ hosts: [daemon] });
    if (path === '/admin/insecure-approvals/pending') return json({ requests: [] });
    return json({});
  });
  return { writes, host };
}

const advanced = (page: Page) => page.getByTestId('host-advanced');
const openAdvanced = (page: Page) => advanced(page).locator(':scope > summary').click();

test('page order: problems first, then engines and access, Advanced collapsed, Delete last, no tabs', async ({ page }) => {
  await fixture(page);
  await page.goto('/admin/hosts/1');
  await expect(page.getByRole('heading', { name: 'workstation.example.test', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  expect((await page.locator('main').getByRole('heading', { level: 2 }).allTextContents()).slice(0, 4)).toEqual(['Needs attention', 'Engines', 'Access', 'Delete host']);
  await expect(advanced(page)).not.toHaveAttribute('open', '');
  await expect(page.getByRole('heading', { name: 'Remote sessions', exact: true })).toBeHidden();
  // Grok is switched off fleet-wide in the fixture: that is information with a link to Engines, not a failure.
  await expect(page.getByRole('listitem').filter({ hasText: 'Grok is switched off fleet-wide' })).toBeVisible();
});

test('Fix on a host without credentials produces the install command', async ({ page }) => {
  const { writes } = await fixture(page, false, true, false, false);
  await page.goto('/admin/hosts/1');
  const item = page.getByRole('listitem').filter({ hasText: 'No credentials received yet' });
  await expect(item).toBeVisible();
  // cxx seeds credentials itself on its next run: shown, but never counted as needing attention.
  await expect(item).toHaveAttribute('data-tone', 'info');
  await item.getByRole('button', { name: /^Fix/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Install command');
  await expect(page.getByLabel('Command', { exact: true })).toHaveValue(/install\/t/);
  expect(writes.some(w => w.path === '/admin/hosts/1/installer')).toBe(true);
});

test('the header action and the Fix share one install-command dialog', async ({ page }) => {
  await fixture(page);
  await page.goto('/admin/hosts/1');
  await page.getByRole('button', { name: 'Get install command' }).click();
  await expect(page.getByRole('dialog')).toContainText('Install command');
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('remote sessions draft is kept and saved from Advanced', async ({ page }) => {
  const { writes } = await fixture(page);
  await page.goto('/admin/hosts/1');
  await openAdvanced(page);
  await page.getByLabel('Working directory', { exact: true }).fill('/tmp/my-draft');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].value.default_cwd).toBe('/tmp/my-draft');
});

test('existing exceptions open Advanced by themselves and a manual collapse sticks', async ({ page }) => {
  await fixture(page, true, true, true);
  await page.goto('/admin/hosts/1');
  await expect(advanced(page)).toHaveAttribute('open', '');
  await expect(page.getByRole('region', { name: 'Codex engine overrides' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Codex engine', exact: true })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Grok engine', exact: true })).toBeDisabled();
  await advanced(page).locator(':scope > summary').click();
  await expect(advanced(page)).not.toHaveAttribute('open', '');
  await page.reload();
  await expect(advanced(page)).toHaveAttribute('open', '');
});

test('read-only operators see disabled forms', async ({ page }) => {
  await fixture(page, false, false);
  await page.goto('/admin/hosts/1');
  await openAdvanced(page);
  await expect(page.getByLabel('Service account', { exact: true })).toBeDisabled();
});

for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) {
  test(`host detail ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem('codex.theme', theme), theme);
    await fixture(page, true, true, width === 1024);
    await page.goto('/admin/hosts/1');
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
    for (const state of ['open', 'closed']) {
      const isOpen = (await advanced(page).getAttribute('open')) !== null;
      if (isOpen !== (state === 'open')) await openAdvanced(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: `test-results/host-detail-${width}-${theme}-${state}.png`, fullPage: true });
    }
  });
}

test('online evidence ages out even when cached replies repeat and admin timestamps are fresh', async ({ page }) => {
  await page.clock.install();
  await fixture(page);
  await page.goto('/admin/hosts/1');
  await expect(page.locator('main').getByText('Online', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText(/Last contact/)).toBeVisible();
  await page.clock.fastForward(46_000);
  await expect(page.locator('main').getByText('Offline', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('Online', { exact: true })).toHaveCount(0);
});

test('an idle connected host view makes no periodic HTTP reads for ten minutes', async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page);
  Object.assign(state.host, { presence_source: 'connection' });
  const reads: string[] = [];
  page.on('request', request => {
    if (request.method() === 'GET' && request.headers().accept?.includes('application/json')) reads.push(new URL(request.url()).pathname);
  });
  await page.goto('/admin/hosts/1');
  await expect(page.getByRole('heading', { name: 'workstation.example.test', level: 1 })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  // Drain the initial hello's snapshot reconciliation before measuring idle.
  for (let settle = 0; settle < 3; settle++) {
    await page.waitForLoadState("networkidle");
    await page.clock.runFor(1000);
  }
  await page.waitForLoadState("networkidle");
  const before = reads.length;
  await page.clock.runFor(600_000);
  expect(reads.slice(before)).toEqual([]);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
});
