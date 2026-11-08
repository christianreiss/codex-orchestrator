import { test, expect } from '@playwright/test';
import { CHATTY_RICH_EVENTS, installFixtures } from './admin-fixtures';

for (const suggestion of [false, true]) {
  test(`Chatty preserves ${suggestion ? 'an unrelated composer draft after a suggestion' : 'text typed while sending'}`, async ({ page }) => {
    await installFixtures(page, path => {
      if (path === '/admin/chatty/status') return { visible: true, ready: true, enabled: true, engines: [{ engine: 'codex', ready: true, models: [], reason: null }] };
      if (path === '/admin/chatty/session') return { generation: 1, selection: { engine: null, model: null }, events: suggestion ? CHATTY_RICH_EVENTS : [], active: null, has_older: false };
      return undefined;
    });
    await page.route('**/admin/chatty/events', route => route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' }));
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    await page.route('**/admin/chatty/messages', async route => {
      started = true;
      await response;
      await route.fulfill({ json: { status: 'ok', data: { id: 'fixture-run', status: 'queued' } } });
    });
    await page.goto('/admin/hosts');
    await page.getByRole('button', { name: 'Chatty öffnen' }).click();
    const input = page.getByRole('textbox', { name: 'Nachricht an Chatty' });
    await input.fill(suggestion ? 'Independent draft' : 'Submitted draft');
    if (suggestion) await page.getByRole('group', { name: 'Vorgeschlagene Rückfragen' }).getByRole('button', { name: 'Ist console.example.test aktuell?' }).click();
    else await page.getByRole('button', { name: 'Nachricht senden' }).click();
    await expect.poll(() => started).toBe(true);
    if (!suggestion) await input.fill('Newer draft entered while waiting');
    release();
    await expect(page.getByRole('button', { name: 'Nachricht senden' })).toBeEnabled();
    await expect(input).toHaveValue(suggestion ? 'Independent draft' : 'Newer draft entered while waiting');
  });
}

test('AI generation locks its prompt and mode and ignores a canceled response', async ({ page }) => {
  await installFixtures(page);
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route('**/admin/skills/generate', async route => {
    started = true;
    await response;
    await route.fulfill({ json: { status: 'ok', data: { manifest: 'Obsolete generated manifest' } } });
  });
  await page.goto('/admin/library/skills/design-fixture');
  const manifest = page.getByRole('textbox', { name: 'Skill manifest' });
  const original = await manifest.inputValue();
  await page.getByRole('button', { name: 'AI assist', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI assist', exact: true });
  const prompt = dialog.getByRole('textbox', { name: 'Skill description for the draft' });
  await prompt.fill('Original generation prompt');
  await dialog.getByRole('button', { name: 'Generate manifest', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await expect(prompt).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Ask about this skill' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  release();
  await expect(manifest).toHaveValue(original);
  await page.getByRole('button', { name: 'AI assist', exact: true }).click();
  await expect(prompt).toBeEnabled();
  await prompt.fill('Next generation prompt');
  await expect(prompt).toHaveValue('Next generation prompt');
  await expect(manifest).toHaveValue(original);
});

test('project discard restores both baselines and invalidates delayed assistance', async ({ page }) => {
  await installFixtures(page);
  await page.goto('/admin/projects/fleet-console');
  const about = page.getByRole('button', { name: 'About', exact: true });
  await about.click();
  const dialog = page.getByRole('dialog', { name: 'Project details' });
  const title = dialog.getByRole('textbox', { name: 'Title', exact: true });
  const roster = dialog.getByRole('textbox', { name: 'Roster', exact: true });
  await title.fill('Discarded project title');
  await roster.fill('Discarded roster');
  page.once('dialog', decision => decision.dismiss());
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(title).toHaveValue('Discarded project title');
  page.once('dialog', decision => decision.accept());
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await about.click();
  await expect(title).toHaveValue('Fleet console');
  await expect(roster).toHaveValue('# Roster\n- @operator — owner');
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route('**/admin/projects/fleet-console/assist', async route => {
    started = true;
    await response;
    await route.fulfill({ json: { status: 'ok', data: { about: { title: 'Obsolete assist title' } } } });
  });
  await dialog.getByRole('button', { name: 'AI-Assist', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await about.click();
  release();
  await expect(dialog.getByRole('button', { name: 'AI-Assist', exact: true })).toBeEnabled();
  await expect(title).toHaveValue('Fleet console');
});

test('quota edits replace saved feedback with dirty state and guard navigation', async ({ page }) => {
  const policy = { unlimited: false, short_warn_percent: 85, long_warn_percent: 85, short_auto_resume: false, long_auto_resume: false };
  await installFixtures(page, path => path.startsWith('/admin/quota-policy/') ? { defaults: policy, override: null, effective: policy, emulation: { enabled: false, window_hours: 5, action: 'suggest_pause', auto_resume: false } } : undefined);
  await page.goto('/admin/limits#quota-policy');
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save quota policy', exact: true }) }).first();
  await form.getByRole('button', { name: 'Save quota policy', exact: true }).click();
  await expect(form.getByText('Quota policy saved.', { exact: true })).toBeVisible();
  await form.getByRole('spinbutton', { name: 'Warning threshold (%)' }).first().fill('80');
  await expect(form.getByText('Unsaved quota policy changes.', { exact: true })).toBeVisible();
  await expect(form.getByText('Quota policy saved.', { exact: true })).toHaveCount(0);
  let prompted = false;
  page.once('dialog', decision => { prompted = true; return decision.dismiss(); });
  await page.getByRole('link', { name: 'Hosts', exact: true }).first().click();
  await expect.poll(() => prompted).toBe(true);
  await expect(page).toHaveURL(/\/admin\/limits/);
  await expect(form.getByRole('spinbutton', { name: 'Warning threshold (%)' }).first()).toHaveValue('80');
});

for (const fails of [false, true]) {
  test(`Chatty preserves text typed during a ${fails ? 'failed' : 'successful'} conversation reset`, async ({ page }) => {
    await installFixtures(page, path => {
      if (path === '/admin/chatty/status') return { visible: true, ready: true, enabled: true, engines: [{ engine: 'codex', ready: true, models: [], reason: null }] };
      if (path === '/admin/chatty/session') return { generation: 1, selection: { engine: null, model: null }, events: [], active: null, has_older: false };
      return undefined;
    });
    await page.route('**/admin/chatty/events', route => route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' }));
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    await page.route('**/admin/chatty/session', async route => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      started = true;
      await response;
      await route.fulfill({ status: fails ? 500 : 200, json: fails ? { status: 'error', message: 'Reset failed' } : { status: 'ok', data: {} } });
    });
    await page.goto('/admin/hosts');
    await page.getByRole('button', { name: 'Chatty öffnen' }).click();
    const input = page.getByRole('textbox', { name: 'Nachricht an Chatty' });
    await input.fill('Text before reset');
    const reset = page.getByRole('button', { name: 'Neues Gespräch', exact: true });
    await reset.click();
    await expect.poll(() => started).toBe(true);
    await input.fill('New text typed while reset was pending');
    release();
    await expect(reset).toBeEnabled();
    await expect(input).toHaveValue('New text typed while reset was pending');
    if (fails) await expect(page.getByText('Reset failed', { exact: true })).toBeVisible();
  });
}
