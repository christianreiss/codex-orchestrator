import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function fixture(page: Page, overrides = false, manage = true, singleEngine = false) {
  const stamp = new Date().toISOString();
  const host = {
    id: 1, fqdn: 'workstation.example.test', secure: true, status: 'active', authed: true,
    engines: singleEngine ? 'codex' : 'codex,claude,grok', engines_list: singleEngine ? ['codex'] : ['codex', 'claude', 'grok'],
    ip4: '192.0.2.10', ip6: '2001:db8::10', last_refresh: stamp, last_cron_check: stamp,
    updated_at: stamp, users: [], api_calls: 42, client_version: '1.2.3', claude_client_version: '2.3.4',
    grok_client_version: '1.0.50', model_override: overrides ? 'gpt-6.1-sol' : null,
    effective_auto_update_enabled: true, reverse_dns_mode: 'global',
  };
  const rule = { enabled: true, retention_days: 30, max_bytes: 5 * 1024 ** 3, min_age_days: 7 };
  const policies = Object.fromEntries(['codex', 'claude', 'grok'].map(engine => [engine, { ...rule, source: 'fleet', override: null, fleet: { ...rule } }]));
  let daemon = { host_id: 1, enabled: true, username: 'chris', default_cwd: '', max_parallel: 8, idle_minutes: 60, question_minutes: 1440,
    access: { secure: true, allowed: true }, health: { state: 'green', reasons: [], heartbeat_at: stamp, used_slots: 0, max_slots: 8 }, sessions: [] };
  const writes: { path: string; value: any }[] = [];
  await page.routeWebSocket('**/host-detail-ws', () => {});
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
    if (path === '/admin/hosts/1/session-housekeeping') return json({ policies, last_run: null });
    if (path.startsWith('/admin/hosts/1/session-housekeeping/')) {
      const engine = path.split('/').pop()!; const value = req.postDataJSON(); writes.push({ path, value });
      policies[engine] = { ...(value.inherit ? rule : value), source: value.inherit ? 'fleet' : 'host', override: value.inherit ? null : value, fleet: rule };
      return json(policies[engine]);
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

test('tabs use URLs and preserve remote and housekeeping drafts', async ({ page }) => {
  const { writes } = await fixture(page);
  await page.goto('/admin/hosts/1');
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Remote sessions', exact: true })).toBeHidden();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/tab=settings/);
  await expect(page.getByRole('button', { name: /Model & version overrides/ })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('tab', { name: 'Operations', exact: true }).click();
  await page.getByLabel('Working directory', { exact: true }).fill('/tmp/my-draft');
  await page.getByRole('button', { name: 'Edit codex housekeeping' }).click();
  await page.getByRole('switch', { name: 'Use fleet rule' }).click();
  await page.getByLabel('Retention (days)').fill('45');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.goBack();
  await expect(page.getByLabel('Working directory', { exact: true })).toHaveValue('/tmp/my-draft');
  await expect(page.getByLabel('Retention (days)')).toHaveValue('45');
  await page.getByRole('button', { name: 'Edit claude housekeeping' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Retention (days)')).toHaveValue('45');
  await page.getByRole('button', { name: 'Edit claude housekeeping' }).click();
  await page.getByRole('button', { name: 'Save and switch' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByLabel('Retention (days)')).toHaveValue('30');
  expect(writes[0].value.retention_days).toBe(45);
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].value.default_cwd).toBe('/tmp/my-draft');
});

test('existing overrides open automatically and manual collapse survives refresh', async ({ page }) => {
  await fixture(page, true, true, true);
  await page.goto('/admin/hosts/1?tab=settings');
  const trigger = page.getByRole('button', { name: /Model & version overrides/ });
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('region', { name: 'Codex engine overrides' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Codex engine', exact: true })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Grok engine', exact: true })).toBeDisabled();
  await trigger.click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.goBack();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
});

test('read-only operation forms', async ({ page }) => {
  await fixture(page, false, false);
  await page.goto('/admin/hosts/1?tab=operations');
  await expect(page.getByLabel('Service account', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Edit codex housekeeping' }).click();
  await expect(page.getByRole('switch', { name: 'Use fleet rule' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save rule', exact: true })).toBeDisabled();
});

test('housekeeping discard, validation and inherited save', async ({ page }) => {
  const { writes } = await fixture(page);
  await page.goto('/admin/hosts/1?tab=operations');
  await page.getByRole('button', { name: 'Edit codex housekeeping' }).click();
  await page.getByRole('switch', { name: 'Use fleet rule' }).click();
  await page.getByLabel('Minimum age under pressure (days)').fill('31');
  await expect(page.getByRole('button', { name: 'Save rule', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Edit grok housekeeping' }).click();
  await page.getByRole('button', { name: 'Discard and switch' }).click();
  await expect(page.getByLabel('Minimum age under pressure (days)')).toHaveValue('7');
  expect(writes).toHaveLength(0);
  await page.getByRole('switch', { name: 'Use fleet rule' }).click();
  await page.getByLabel('Retention (days)').fill('60');
  await page.getByRole('button', { name: 'Save rule', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(page.getByText('Rule saved.', { exact: true })).toBeVisible();
  await page.getByRole('switch', { name: 'Use fleet rule' }).click();
  await page.getByRole('button', { name: 'Save rule', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].value).toEqual({ inherit: true });
});

for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) {
  test(`compact host sections ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem('codex.theme', theme), theme);
    await fixture(page, true, true, width === 1024);
    await page.goto('/admin/hosts/1');
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
    for (const tab of ['Overview', 'Settings', 'Operations']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      if (tab === 'Operations') await page.getByRole('button', { name: 'Edit codex housekeeping' }).click();
      await expect(page.getByRole('tabpanel')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.locator('main').evaluate(el => el.scrollTop = 0);
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
      await page.screenshot({ path: `test-results/host-detail-${width}-${theme}-${tab}.png`, fullPage: true });
      await page.locator('main').evaluate(el => el.scrollTop = el.scrollHeight);
      await page.screenshot({ path: `test-results/host-detail-bottom-${width}-${theme}-${tab}.png`, fullPage: true });
    }
    await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toBeFocused();
  });
}
