import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Selection } from '../src/lib/api/chatty';
import { CHATTY_RICH_EVENTS, installFixtures } from './admin-fixtures';

test('Chatty gates availability, persists the conversation and confirms concrete changes', async ({ page }) => {
  let generation = 1;
  let selection: Selection = { engine: null, model: null };
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
    if (path === '/admin/chatty/status') return json({ visible: true, ready, enabled: true, knowledge_version: 'test', engines: ['codex', 'claude', 'grok'].map(engine => ({ engine, ready, models: [{ id: 'model', display_name: 'Testmodell' }, { id: 'model-large', display_name: 'Ein Modell mit einem langen Anzeigenamen für schmale Bildschirme' }], default_model: 'model', reason: null })) });
    if (path === '/admin/chatty/session' && req.method() === 'DELETE') { generation++; events = []; active = null; cleared++; return json({ generation }); }
    if (path === '/admin/chatty/session') return json({ generation, selection, events, active, has_older: false });
    if (path === '/admin/chatty/selection' && req.method() === 'PUT') {
      expect(active).toBe(null);
      selection = req.postDataJSON();
      return json(selection);
    }
    if (path === '/admin/chatty/messages') {
      const body = req.postDataJSON();
      expect(body.generation).toBe(generation); expect(body.client_message_id).toMatch(/^[a-f0-9-]{36}$/);
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
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  const engines = dialog.getByRole('group', { name: 'Chatty Engine', exact: true });
  const models = dialog.getByRole('group', { name: 'Chatty Modell', exact: true });
  await expect(engines.getByRole('button', { name: 'Automatisch' })).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['Codex', 'Claude', 'Grok']) {
    const engine = engines.getByRole('button', { name, exact: true });
    await engine.click();
    await expect(engine).toHaveAttribute('aria-pressed', 'true');
    await expect(models.getByRole('button', { name: 'Standardmodell' })).toHaveAttribute('aria-pressed', 'true');
    await models.getByRole('button', { name: 'Testmodell', exact: true }).click();
    await expect(models.getByRole('button', { name: 'Testmodell', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(selection).toEqual({ engine: name.toLowerCase(), model: 'model' });
    await models.getByRole('button', { name: 'Standardmodell' }).click();
    await expect(models.getByRole('button', { name: 'Standardmodell' })).toHaveAttribute('aria-pressed', 'true');
    expect(selection.model).toBe(null);
  }
  await expect(models.getByRole('button', { name: 'Standardmodell' })).toBeEnabled();
  await page.screenshot({ path: '/tmp/chatty-selection-buttons-desktop.png', animations: 'disabled' });
  await engines.getByRole('button', { name: 'Automatisch' }).click();
  await expect(models).toHaveCount(0);
  expect(selection).toEqual({ engine: null, model: null });
  await page.getByRole('textbox', { name: 'Nachricht an Chatty' }).fill('Lösche den Host test.example');
  await page.getByRole('button', { name: 'Nachricht senden' }).click();
  await expect(page.getByText('Host test.example löschen')).toBeVisible();
  expect(decided).toBe(false);
  for (const button of await engines.getByRole('button').all()) await expect(button).toBeDisabled();
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
  await engines.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(models).toBeVisible();
  const longModel = models.getByRole('button', { name: 'Ein Modell mit einem langen Anzeigenamen für schmale Bildschirme', exact: true });
  await longModel.focus();
  await longModel.press('Enter');
  await expect(longModel).toHaveAttribute('aria-pressed', 'true');
  await expect(models.getByRole('button', { name: 'Standardmodell' })).toHaveAttribute('aria-pressed', 'false');
  await expect(longModel).toBeEnabled();
  expect(selection).toEqual({ engine: 'codex', model: 'model-large' });
  expect(await models.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/chatty-selection-buttons-mobile.png', animations: 'disabled' });
  await page.getByRole('textbox', { name: 'Nachricht an Chatty' }).fill('Unsaved old draft');
  await page.getByRole('button', { name: 'Neues Gespräch' }).click();
  await expect.poll(() => cleared).toBe(1);
  await expect(page.getByRole('button', { name: 'Jetzt leeren' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Behalten' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Nachricht an Chatty' })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Nachricht an Chatty' })).toBeFocused();
  await expect(page.getByText('Änderung ausgeführt')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Nachricht an Chatty' }).fill('Neues Thema');
  await page.getByRole('button', { name: 'Nachricht senden' }).click();
  await expect(dialog.getByText('Neues Thema', { exact: true })).toBeVisible();
  expect(generation).toBe(2);
  await page.getByRole('button', { name: 'Neues Gespräch' }).click();
  await expect.poll(() => cleared).toBe(2);
  await expect(page.getByRole('button', { name: 'Bestätigen', exact: true })).toHaveCount(0);
  await expect(page.getByText('Was möchtest du wissen oder ändern?', { exact: false })).toBeVisible();
  ready = false;
  await page.reload();
  await page.getByRole('button', { name: 'Chatty öffnen' }).click();
  await expect(page.getByText('Chatty ist gerade nicht verfügbar.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nachricht senden' })).toBeDisabled();
});

test('Chatty answers carry verified console links and follow-up suggestions', async ({ page }) => {
  let events: unknown[] = [...CHATTY_RICH_EVENTS];
  const sent: string[] = [];
  await installFixtures(page, (path, body) => {
    if (path === '/admin/chatty/status') return { visible: true, ready: true, enabled: true, knowledge_version: 'test', engines: [{ engine: 'codex', ready: true, reason: null, default_model: 'test', models: [{ id: 'test', display_name: 'Test' }] }] };
    if (path === '/admin/chatty/session') return { generation: 1, selection: { engine: null, model: null }, events, active: null, has_older: false };
    if (path === '/admin/chatty/messages') {
      const text = (body as { text: string }).text; sent.push(text);
      events = [...events, { id: 5, kind: 'user', runId: 'run-next', createdAt: '2026-10-28T08:02:00Z', body: { text } }];
      return { id: 'run-next', status: 'queued' };
    }
    return undefined;
  });
  await page.route('**/admin/chatty/events', route => route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' }));
  await page.goto('/admin/hosts');
  await page.getByRole('button', { name: 'Chatty öffnen' }).click();
  const dialog = page.getByRole('dialog');
  const links = dialog.getByRole('group', { name: 'Verweise aus Chattys Antwort' });
  await expect(links.getByRole('link')).toHaveCount(2);
  const host = links.getByRole('link', { name: 'Host console.example.test öffnen' });
  await expect(host).toHaveAttribute('href', '/admin/hosts/1');
  await expect(links.getByRole('link', { name: /^Hilfe: Hosts/ })).toHaveAttribute('href', '/admin/manual/hosts');
  for (const label of ['Externer Link', 'Doppelte Basis', 'Skript', 'Alte Rückfrage']) await expect(dialog.getByText(label)).toHaveCount(0);
  await expect(dialog.getByText('Ein Verweis konnte nicht geprüft werden und wurde weggelassen.')).toBeVisible();
  const audit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(audit.violations).toEqual([]);
  await page.screenshot({ path: '/tmp/chatty-rich-elements-desktop.png' });

  // Keyboard activation navigates in place; the desktop panel and its conversation stay open.
  await host.focus();
  await host.press('Enter');
  await expect(page).toHaveURL(/\/admin\/hosts\/1$/);
  await expect(dialog).toBeVisible();
  await expect(host).toBeVisible();

  // A suggestion sends exactly its visible text as the next message.
  await dialog.getByRole('group', { name: 'Vorgeschlagene Rückfragen' }).getByRole('button', { name: 'Ist console.example.test aktuell?' }).click();
  await expect.poll(() => sent).toEqual(['Ist console.example.test aktuell?']);
  await expect(dialog.getByRole('group', { name: 'Vorgeschlagene Rückfragen' })).toHaveCount(0);

  // On a phone the full-screen panel minimizes after navigation and reopens with the same conversation.
  await page.setViewportSize({ width: 390, height: 844 });
  const manual = links.getByRole('link', { name: /^Hilfe: Hosts/ });
  const bounds = await manual.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/chatty-rich-elements-mobile.png' });
  await manual.click();
  await expect(page).toHaveURL(/\/admin\/manual\/hosts$/);
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Chatty öffnen' }).click();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Host console.example.test öffnen' })).toBeVisible();
});

test('Chatty action buttons navigate directly or confirm through the existing admin endpoints', async ({ page }) => {
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  const token = (name: string) => `v1.bGVnYWN5.${name}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  const host = 'console.example.test';
  const action = (name: string, a: string, risk: string, label: string, params: Record<string, unknown>, expires = future) =>
    ({ type: 'action', action: a, risk, label, params, proposal: token(name), expires_at: expires });
  const events = [
    { id: 1, kind: 'user', runId: 'run', createdAt: '2026-10-29T08:00:00Z', body: { text: `Was kann ich mit ${host} tun?` } },
    {
      id: 2, kind: 'answer', runId: 'run', createdAt: '2026-10-29T08:00:05Z',
      body: {
        text: `${host} nutzt nur Codex.`, engine: 'codex', model: 'test', sources: [],
        elements: [
          action('enable', 'host.engine.enable', 'confirm', `Claude auf ${host} aktivieren`, { host: 1, engine: 'claude' }),
          action('disable', 'host.engine.disable', 'danger', `Codex auf ${host} deaktivieren`, { host: 1, engine: 'codex' }),
          action('filter', 'hosts.filter', 'safe', 'Hosts anzeigen: offline', { status: 'offline' }),
          action('old', 'account.verify', 'confirm', 'Konto Alt prüfen', { account: 3 }, '2026-10-01T00:00:00Z'),
          // Tampered: a mutation that claims to be safe must not render as a direct click.
          action('tampered', 'host.engine.disable', 'safe', 'Sofort deaktivieren', { host: 1, engine: 'codex' }),
          { type: 'action', action: 'host.delete', risk: 'danger', label: 'Host löschen', params: { host: 1 }, proposal: token('x'), expires_at: future },
        ],
      },
    },
  ];
  const verifications: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let disableChecks = 0;
  const check = (title: string, confirm: string, plan: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    available: true, risk: 'confirm', title, confirm_label: confirm, confirm_text: null, summary: [`${title} Zusammenfassung.`],
    target: { kind: 'host', id: 1, name: host }, plan, params: {}, expires_at: future, ...extra,
  });
  await installFixtures(page, (path, body) => {
    if (path === '/admin/chatty/status') return { visible: true, ready: true, enabled: true, knowledge_version: 'test', engines: [{ engine: 'codex', ready: true, reason: null, default_model: 'test', models: [{ id: 'test', display_name: 'Test' }] }] };
    if (path === '/admin/chatty/session') return { generation: 1, selection: { engine: null, model: null }, events, active: null, has_older: false };
    if (path === '/admin/chatty/proposals/verify') {
      const proposal = (body as { proposal: string }).proposal;
      verifications.push(proposal);
      if (proposal === token('enable'))
        return { ...check(`Claude auf ${host} aktivieren?`, 'Claude aktivieren', { host_id: 1, engine: 'claude', engines_before: ['codex'], engines_after: ['codex', 'claude'] }), action: 'host.engine.enable', label: `Claude auf ${host} aktivieren` };
      if (proposal === token('disable')) {
        // The host changed between opening the dialog and confirming: the second check returns a new plan.
        const before = ++disableChecks === 1 ? ['codex', 'claude'] : ['codex', 'claude', 'grok'];
        return { ...check(`Codex auf ${host} deaktivieren?`, 'Codex deaktivieren', { host_id: 1, engine: 'codex', engines_before: before, engines_after: before.filter(e => e !== 'codex') }, { risk: 'danger', confirm_text: host }), action: 'host.engine.disable', label: `Codex auf ${host} deaktivieren` };
      }
      return { available: false, reason: 'expired', detail: 'Dieser Vorschlag ist abgelaufen.' };
    }
    if (path === '/admin/hosts/1/engines') { posts.push({ path, body }); return { host: { id: 1, fqdn: host } }; }
    return undefined;
  });
  await page.route('**/admin/chatty/events', route => route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' }));
  await page.goto('/admin/dashboard');
  await page.getByRole('button', { name: 'Chatty öffnen' }).click();
  const panel = page.getByRole('dialog', { name: 'Chatty' });
  const group = panel.getByRole('group', { name: 'Aktionen aus Chattys Antwort' });
  await expect(group.getByRole('button')).toHaveCount(3);
  await expect(group.getByRole('link')).toHaveCount(1);
  for (const label of ['Sofort deaktivieren', 'Host löschen']) await expect(panel.getByText(label)).toHaveCount(0);
  await expect(group.getByRole('button', { name: /Konto Alt prüfen/ })).toBeDisabled();
  await expect(panel.getByText('Aktionsvorschläge gelten 15 Minuten', { exact: false })).toBeVisible();
  await page.screenshot({ path: '/tmp/chatty-actions-desktop.png' });
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);

  // Confirm: the dialog names the target and the change; the click goes to the existing engines endpoint.
  await group.getByRole('button', { name: /Claude auf console\.example\.test aktivieren/ }).click();
  const confirm = page.getByRole('dialog', { name: `Claude auf ${host} aktivieren?` });
  await expect(confirm.getByText(`Host ${host}`)).toBeVisible();
  // Scan the settled dialog: mid-fade colors blend with the overlay and are not what the operator reads.
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({ path: '/tmp/chatty-action-confirm-desktop.png' });
  // Escape closes only the confirmation; nothing ran and the conversation stays open.
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(panel).toBeVisible();
  expect(posts).toEqual([]);
  await group.getByRole('button', { name: /Claude auf console\.example\.test aktivieren/ }).click();
  await confirm.getByRole('button', { name: 'Claude aktivieren' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/admin/hosts/1/engines', body: { engines: ['codex', 'claude'] } }]);
  await expect(confirm).toHaveCount(0);
  await expect(panel.getByText(`Claude auf ${host} aktivieren: ausgeführt`)).toBeVisible();
  expect(verifications.filter(v => v === token('enable'))).toHaveLength(3);

  // Danger: typing the host name is required, and a changed target needs a new confirmation.
  await group.getByRole('button', { name: /Codex auf console\.example\.test deaktivieren/ }).click();
  const danger = page.getByRole('dialog', { name: `Codex auf ${host} deaktivieren?` });
  const go = danger.getByRole('button', { name: 'Codex deaktivieren' });
  await expect(go).toBeDisabled();
  await danger.getByRole('textbox').fill('console.example');
  await expect(go).toBeDisabled();
  await danger.getByRole('textbox').fill(host);
  await expect(go).toBeEnabled();
  await go.click();
  await expect(danger.getByText('Der Zustand hat sich geändert', { exact: false })).toBeVisible();
  expect(posts).toHaveLength(1);
  await go.click();
  await expect.poll(() => posts.at(-1)).toEqual({ path: '/admin/hosts/1/engines', body: { engines: ['claude', 'grok'] } });
  await expect(panel.getByText(`Codex auf ${host} deaktivieren: ausgeführt`)).toBeVisible();
  // Outcome lines sit on the answer background; scan them once the confirmation has closed.
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);

  // On a phone the confirmation still fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await group.getByRole('button', { name: /Claude auf console\.example\.test aktivieren/ }).click();
  await expect(confirm.getByRole('button', { name: 'Claude aktivieren' })).toBeEnabled();
  // The shared dialog's opening animation briefly overrides its centering transform.
  await expect.poll(() => confirm.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  await page.screenshot({ path: '/tmp/chatty-action-confirm-mobile.png' });
  const small = await confirm.boundingBox();
  expect(small!.x).toBeGreaterThanOrEqual(0); expect(small!.x + small!.width).toBeLessThanOrEqual(390);
  await confirm.getByRole('button', { name: 'Abbrechen' }).click();
  await page.setViewportSize({ width: 1280, height: 800 });

  // Safe navigation runs directly, without a verification round trip.
  const before = verifications.length;
  await group.getByRole('link', { name: 'Hosts anzeigen: offline' }).click();
  await expect(page).toHaveURL(/\/admin\/hosts\?status=offline$/);
  expect(verifications.length).toBe(before);
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
