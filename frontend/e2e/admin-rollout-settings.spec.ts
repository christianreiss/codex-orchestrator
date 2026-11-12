import { expect, test, type Page } from '@playwright/test';

type Posts = Array<{ path: string; body: unknown }>;

async function fixture(page: Page, opts: { manage?: boolean; failHalt?: boolean } = {}) {
  const manage = opts.manage ?? true;
  const state = { enabled: false, source: 'env' as 'env' | 'setting', status: 'active' as 'active' | 'halted' };
  const posts: Posts = [];
  const rollout = () => ({
    enabled: state.enabled, enabled_source: state.source,
    settings: { stages: ['canary', 'early', 'all'], soak_minutes: 30 },
    hosts: [{ id: 1, canary: true, excluded: false, running: '1.0.0', admitted: true }],
    rollout: {
      id: 'r1', target_version: '1.2.0', from_version: '1.1.0', stage_index: 0, stage: 'canary', next_stage: 'early',
      stage_started_at: '2026-11-12T08:00:00Z', soak_minutes: 30, soak_ends_at: '2026-11-12T08:30:00Z', status: state.status,
      halted_reason: null, admitted_host_ids: [1], confirmed_host_ids: [], started_at: '2026-11-12T08:00:00Z', history: [],
    },
  });
  await page.route('**/admin/**', route => {
    const req = route.request();
    if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'operator', roles: [manage ? 'owner' : 'viewer'] }, capabilities: ['admin.read', 'settings.read', 'hosts.read', ...(manage ? ['hosts.manage', 'settings.manage'] : [])] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: '2026-10-09T08:00:00Z', dismissed_at: null } });
    if (path === '/admin/ws/info') return json({ enabled: false });
    if (path === '/admin/wrapper/rollout') return json(rollout());
    if (path === '/admin/wrapper/rollout/enabled' && req.method() === 'POST') {
      posts.push({ path, body: req.postDataJSON() });
      state.enabled = req.postDataJSON().enabled; state.source = 'setting';
      return json({ enabled: state.enabled, source: state.source });
    }
    if (path.startsWith('/admin/wrapper/rollout/') && req.method() === 'POST') {
      posts.push({ path, body: req.postDataJSON() });
      if (opts.failHalt) return json({ status: 'error', message: 'Rollout is locked by another operator' }, 409);
      state.status = path.endsWith('/halt') ? 'halted' : 'active';
      return json(rollout());
    }
    if (path === '/admin/communicator/api-version') return json({ api_version: 1, min_api: 1, default_min_api: 1, override_min_api: null, override_updated_at: null, clients: { hosts: { observed: 0, below_min: 0, below_current: 0, at_current: 0, unreported: 0 }, communicators: { observed: 0, below_min: 0, below_current: 0, at_current: 0, unreported: 0 } } });
    return json({});
  });
  return { state, posts };
}

test('the rollout switch is stored and says where its value comes from', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/admin/settings#cxx-rollout');
  await expect(page.getByRole('tab', { name: 'Rollout & tools' })).toHaveAttribute('aria-selected', 'true');
  const toggle = page.getByRole('switch', { name: 'Stage new releases' });
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#wrapper-rollout')).toContainText('Using the server default');
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(f.posts).toEqual([{ path: '/admin/wrapper/rollout/enabled', body: { enabled: true } }]);
  await expect(page.locator('#wrapper-rollout')).toContainText('Set here');
  // The old "set an environment variable" instruction is gone.
  await expect(page.locator('#cxx-rollout')).not.toContainText('CXX_WRAPPER_ROLLOUT_ENABLED=');
});

test('halting asks first and a failure stays in the dialog', async ({ page }) => {
  const f = await fixture(page, { failHalt: true });
  f.state.enabled = true; f.state.source = 'setting';
  await page.goto('/admin/settings?group=rollout');
  await page.getByRole('button', { name: 'Halt', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Halt this rollout?' });
  await expect(dialog).toBeVisible();
  expect(f.posts).toEqual([]);
  await dialog.getByRole('button', { name: 'Halt rollout' }).click();
  await expect(dialog).toContainText('Rollout is locked by another operator');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('read-only operators see the permission instead of an editable switch', async ({ page }) => {
  await fixture(page, { manage: false });
  await page.goto('/admin/settings?group=rollout');
  await expect(page.getByRole('switch', { name: 'Stage new releases' })).toBeDisabled();
  await expect(page.locator('#wrapper-rollout')).toContainText('hosts.manage');
  await expect(page.getByRole('button', { name: 'Halt', exact: true })).toBeDisabled();
});
