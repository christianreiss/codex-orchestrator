import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('Chatty gates availability, persists the conversation and confirms concrete changes', async ({ page }) => {
  let generation = 1;
  let events: unknown[] = [];
  let active: { id: string; status: string; generation: number; steps: number } | null = null;
  let ready = true;
  let cleared = 0;
  let decided = false;
  await page.route('**/admin/**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (path === '/admin/chatty/events') return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (!req.headers().accept?.includes('application/json')) return route.continue();
    const json = (data: unknown) => route.fulfill({ json: { status: 'ok', data } });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'owner', roles: ['owner'] }, capabilities: ['admin.read', 'chatty.use', 'chatty.manage'] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: '2026-10-09', dismissed_at: null } });
    if (path === '/admin/ws/info') return json({ enabled: false });
    if (path === '/admin/engines/state') return json({ engines: ['codex', 'claude', 'grok'].map(engine => ({ engine, enabled: true })) });
    if (path === '/admin/hosts') return json({ hosts: [] });
    if (path === '/admin/chatty/status') return json({ visible: true, ready, enabled: true, knowledge_version: 'test', engines: [{ engine: 'codex', ready, models: [{ id: 'model', display_name: 'Testmodell' }], default_model: 'model', reason: null }] });
    if (path === '/admin/chatty/session' && req.method() === 'DELETE') { generation++; events = []; active = null; cleared++; return json({ generation }); }
    if (path === '/admin/chatty/session') return json({ generation, selection: { engine: null, model: null }, events, active, has_older: false });
    if (path === '/admin/chatty/messages') {
      const body = req.postDataJSON();
      expect(body.generation).toBe(1); expect(body.client_message_id).toMatch(/^[a-f0-9-]{36}$/);
      expect(body.context).toEqual({ page: 'hosts' });
      events = [{ id: 1, kind: 'user', runId: 'run', body: { text: body.text } }, { id: 2, kind: 'action', runId: 'run', body: { id: 'action', tool: 'host_delete', description: 'Host test.example löschen', status: 'pending', arguments: { id: 42 }, before: { fqdn: 'test.example' } } }];
      active = { id: 'run', status: 'waiting_confirmation', generation, steps: 1 };
      return json({ id: 'run', status: 'queued' });
    }
    if (path === '/admin/chatty/actions/action/decision') {
      expect(req.postDataJSON()).toEqual({ approve: true, generation: 1 }); decided = true; active = null;
      events.push({ id: 3, kind: 'result', runId: 'run', body: { id: 'action', tool: 'host_delete', status: 'succeeded', result: { deleted: true } } });
      return json({ accepted: true });
    }
    return json({});
  });
  await page.goto('/admin/hosts');
  await page.getByRole('button', { name: 'Chatty öffnen' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.getByRole('textbox', { name: 'Nachricht an Chatty' }).fill('Lösche den Host test.example');
  await page.getByRole('button', { name: 'Nachricht senden' }).click();
  await expect(page.getByText('Host test.example löschen')).toBeVisible();
  expect(decided).toBe(false);
  await page.getByText('Änderung ansehen').click();
  await expect(dialog.getByText('"id": 42', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Bestätigen', exact: true }).click();
  await expect(page.getByText('Änderung ausgeführt')).toBeVisible();
  expect(decided).toBe(true);
  await page.getByRole('button', { name: 'Chatty minimieren' }).click();
  await page.getByRole('button', { name: 'Chatty öffnen' }).click();
  await expect(page.getByText('Änderung ausgeführt')).toBeVisible();
  await page.screenshot({ path: '/tmp/chatty-desktop-preview.png' });
  const audit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(audit.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Gespräch leeren' }).click();
  await page.getByRole('button', { name: 'Jetzt leeren' }).click();
  expect(cleared).toBe(1);
  await expect(page.getByText('Änderung ausgeführt')).toHaveCount(0);
  ready = false;
  await page.reload();
  await page.getByRole('button', { name: 'Chatty öffnen' }).click();
  await expect(page.getByText('Chatty ist gerade nicht verfügbar.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nachricht senden' })).toBeDisabled();
});

for (const role of ['owner', 'viewer']) {
test(`Chatty is absent for ${role} without eligible access`, async ({ page }) => {
  await page.route('**/admin/**', route => {
    const req = route.request(); if (!req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname;
    const data = path === '/admin/auth/status' ? { authenticated: true, user: { id: 2, username: role, roles: [role] }, capabilities: role === 'owner' ? ['admin.read', 'chatty.use', 'chatty.manage'] : ['admin.read'] }
      : path === '/admin/setup/status' ? { setup_complete: true, critical_complete: true, wizard: { completed_at: '2026-10-09' }, next_actions: [], checks: [] }
      : path === '/admin/hosts' ? { hosts: [] } : path === '/admin/chatty/status' ? { visible: false, ready: false, engines: [] } : {};
    return route.fulfill({ json: { status: 'ok', data } });
  });
  await page.goto('/admin/hosts');
  await expect(page.locator('main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chatty öffnen' })).toHaveCount(0);
});

}
