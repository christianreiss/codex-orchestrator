import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { FeedbackItem, FeedbackConfiguration } from '../src/lib/api/feedback';

const id = '00000000-0000-4000-8000-000000000061';
const stamp = '2026-10-12T08:00:00.000Z';
async function fixture(page: Page, manage = true, userMode = false) {
  let enabled = false;
  let configuration: FeedbackConfiguration = { mode: userMode ? 'user' : 'source_developer', auto_publish: false,
    runner_enabled: false, engine: null, model: null, token_configured: false, revision: 'initial', repository: 'christianreiss/codex-orchestrator' };
  let item: FeedbackItem = {
    id, title: 'Wrapper manifest parsing fails', type: 'bug', priority: 'high', component: 'wrapper',
    status: 'open', version: 1, report: { description: 'Original reproduction evidence', actual: 'Parser throws', expected: 'Manifest loads' },
    source: { host_id: 32, engine: 'codex' }, claim_owner: null as Record<string, unknown> | null,
    claim_expires_at: null as string | null, result: null as Record<string, unknown> | null,
    deployment: 'unknown', deployment_ref: null as string | null, duplicate_of: null,
    created_at: stamp, updated_at: stamp,
  };
  if (userMode) item.pipeline = { version_state: 'old_version', review_state: 'needs_retest', delivery_state: 'local',
    created_commit: 'a'.repeat(40), tested_commit: 'a'.repeat(40), upstream_commit: 'b'.repeat(40),
    github_url: null, github_issue_number: null, reason: 'old_version: update and retest before publishing',
    checked_at: null, next_attempt_at: null, updated_at: stamp, evidence_urls: [], probe: null, baseline: null, retest: null };
  const events: Record<string, unknown>[] = [{ id: 'event1', version: 1, action: 'submitted', actor: item.source, detail: { report: item.report }, created_at: stamp }];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/admin/**', async (route) => {
    const req = route.request();
    if (req.resourceType() === 'document' || !req.headers().accept?.includes('application/json')) return route.continue();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'operator', roles: ['owner'] }, capabilities: ['admin.read', 'feedback.read', ...(manage ? ['feedback.manage'] : [])] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: stamp, dismissed_at: null } });
    if (path === '/admin/ws/info') return json({ enabled: false });
    if (req.method() === 'POST') {
      const body = req.postDataJSON(); writes.push({ path, body });
      if (path === '/admin/feedback/configuration') {
        configuration = { ...configuration, ...body.config, revision: 'saved', token_configured: Boolean(body.token) };
        return json(configuration);
      }
      if (path === `/admin/feedback/${id}/recheck`) {
        item = { ...item, version: item.version + 1, pipeline: { ...item.pipeline!, version_state: 'recent', review_state: 'new', delivery_state: 'sent',
          tested_commit: 'b'.repeat(40), github_issue_number: 42, github_url: 'https://github.com/christianreiss/codex-orchestrator/issues/42', reason: 'Publication confirmed on GitHub' } };
        return json({ queued: true });
      }
      if (path === '/admin/feedback/state') { enabled = body.enabled; return json({ enabled }); }
      if (path === '/admin/feedback') { item = { ...item, ...body, report: body }; return json({ feedback: item, replayed: false }); }
      if (path === `/admin/feedback/${id}/claim`) {
        item = { ...item, status: 'open', version: item.version + 1, claim_owner: null, claim_expires_at: null };
        return json({ feedback: item });
      }
      if (body.expected_version !== item.version) return json({ status: 'error', message: 'Feedback changed; read current version before updating', code: 'feedback_version_conflict' }, 409);
      item = { ...item, ...body, version: item.version + 1 };
      if (body.status === 'resolved') { item.result = { resolution: body.resolution, fix_ref: body.fix_ref, verification: body.verification }; item.deployment = body.deployment ?? 'not_deployed'; }
      events.push({ id: `event${item.version}`, version: item.version, action: 'updated', actor: { admin_user_id: 1 }, detail: body, created_at: stamp });
      return json({ feedback: item });
    }
    if (path === '/admin/feedback/state') return json({ enabled });
    if (path === '/admin/feedback/configuration') return json(configuration);
    if (path === '/admin/feedback/summary') return json({ open: item.status === 'open' ? 1 : 0, in_progress: item.status === 'in_progress' ? 1 : 0, blocked: item.status === 'blocked' ? 1 : 0 });
    if (path === '/admin/feedback') {
      const status = url.searchParams.get('status'); const query = url.searchParams.get('query');
      const matches = (!status || status === item.status) && (!query || item.title.includes(query));
      return json({ feedback: matches ? [item] : [], next_offset: null });
    }
    if (path === `/admin/feedback/${id}`) return json({ feedback: item, events });
    return json({});
  });
  return { writes, bump: () => { item.version += 1; }, claim: () => {
    item = { ...item, status: 'in_progress', claim_owner: { host_id: 32, engine: 'grok' }, claim_expires_at: '2099-10-12T10:00:00.000Z' };
  } };
}

test('activation, triage, evidence, verified fix and separate deployment', async ({ page }) => {
  const { writes } = await fixture(page);
  await page.goto('/admin/reports');
  await expect(page.getByRole('switch', { name: 'Agent reports' })).not.toBeChecked();
  await page.getByRole('switch', { name: 'Agent reports' }).click();
  await expect(page.getByRole('switch', { name: 'Agent reports' })).toBeChecked();
  expect(writes[0]).toEqual({ path: '/admin/feedback/state', body: { enabled: true } });
  await page.getByRole('button', { name: /Wrapper manifest parsing fails/ }).click();
  await expect(page.getByText('Original reproduction evidence', { exact: true })).toBeVisible();
  await page.getByLabel('Add evidence or comment').fill('Reproduced on all three engines');
  await page.getByRole('button', { name: 'Save update', exact: true }).click();
  await expect(page.getByText('v2 · updated', { exact: false })).toBeVisible();
  await page.getByLabel('Report status', { exact: true }).selectOption('resolved');
  await page.getByLabel('Resolution', { exact: true }).fill('Corrected manifest parser');
  await page.getByLabel('Fix reference', { exact: true }).fill('commit:abc123');
  await page.getByLabel('Verification', { exact: true }).fill('Regression test and builds passed');
  await page.getByRole('button', { name: 'Save update', exact: true }).click();
  await expect(page.getByText('Deployment: not deployed', { exact: true })).toBeVisible();
  await page.getByLabel('Deployment', { exact: true }).selectOption('deployed');
  await page.getByLabel('Deployment reference').fill('release:v1');
  await page.getByRole('button', { name: 'Save update', exact: true }).click();
  await expect(page.getByText('Deployment: deployed · release:v1', { exact: true })).toBeVisible();
  expect(writes.find((w) => w.body.status === 'resolved')?.body).toMatchObject({ resolution: 'Corrected manifest parser', fix_ref: 'commit:abc123', verification: 'Regression test and builds passed' });
  await page.screenshot({ path: '/tmp/cxx-feedback-desktop.png', animations: 'disabled', fullPage: true });
});

test('User feedback settings require explicit engine/model and persist automatic-publication opt-in without returning the token', async ({ page }) => {
  const { writes } = await fixture(page);
  await page.goto('/admin/reports');
  await page.getByText('Feedback destination and automatic checks', { exact: true }).click();
  await page.getByLabel('Feedback mode', { exact: true }).selectOption('user');
  await page.getByLabel('Enable server checks and API retests').check();
  await page.getByLabel('Review engine', { exact: true }).selectOption('claude');
  await page.getByLabel('Review model', { exact: true }).fill('fixture-model');
  await page.getByLabel('GitHub token', { exact: true }).fill('test-only-not-a-real-token');
  await page.getByLabel('Allow automatic publication', { exact: false }).check();
  await page.getByRole('button', { name: 'Save feedback settings', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  await expect(page.getByLabel('GitHub token', { exact: true })).toHaveValue('');
  expect(writes.find((w) => w.path === '/admin/feedback/configuration')?.body).toMatchObject({ expected_revision: 'initial', config: { mode: 'user', runner_enabled: true, auto_publish: true, engine: 'claude', model: 'fixture-model' } });
});

test('User reports retain separate version/review/delivery state and show confirmed publication after checking', async ({ page }) => {
  await fixture(page, true, true);
  await page.goto('/admin/reports');
  await page.getByRole('button', { name: /Wrapper manifest parsing fails/ }).click();
  const review = page.getByRole('region', { name: 'GitHub review' });
  await expect(review).toContainText('old_version');
  await expect(review).toContainText('Delivery: local');
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(review).toContainText('Version: recent');
  await expect(review.getByRole('link', { name: /Confirmed publication/ })).toHaveAttribute('href', 'https://github.com/christianreiss/codex-orchestrator/issues/42');
});

test('User settings reflow at 320px and expose accessible controls in both themes', async ({ page }) => {
  await fixture(page, true, true);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/admin/reports');
  await page.getByText('Feedback destination and automatic checks', { exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.classList.toggle('dark', value === 'dark'); }, theme);
    await page.waitForTimeout(250); // Allow the shared 120ms theme color transition to settle before contrast measurement.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    const accessibility = await new AxeBuilder({ page }).include('main').analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({ path: `/tmp/cxx-feedback-user-${theme}-320.png`, fullPage: true });
  }
});

test('new report, search and version conflict retain the draft', async ({ page }) => {
  const context = await fixture(page);
  await page.goto('/admin/reports');
  await page.getByRole('button', { name: 'New report', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Missing MCP feature');
  await page.getByLabel('Description', { exact: true }).fill('Agents need a new function');
  await page.getByRole('button', { name: 'Submit report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Missing MCP feature', exact: true })).toBeVisible();
  expect(context.writes[0].body.client_request_id).toMatch(/^[0-9a-f-]{36}$/);
  // The new report opens in a side sheet; close it to use the list filters.
  await page.keyboard.press('Escape');
  await page.getByLabel('Search reports', { exact: true }).fill('no match');
  await expect(page.getByText('No reports match these filters.')).toBeVisible();
  await page.getByLabel('Search reports', { exact: true }).fill('');
  await page.getByRole('button', { name: /Missing MCP feature/ }).click();
  await page.getByLabel('Add evidence or comment').fill('Keep this draft');
  context.bump();
  await page.getByRole('button', { name: 'Save update', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load current version' })).toBeVisible();
  await expect(page.getByLabel('Add evidence or comment')).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: 'Load current version' }).click();
  await page.getByRole('button', { name: 'Save update', exact: true }).click();
  await expect(page.getByLabel('Add evidence or comment')).toHaveValue('');
});

test('mobile read-only details and retained disabled history', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, false);
  await page.goto('/admin/reports');
  await expect(page.getByRole('switch', { name: 'Agent reports' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New report', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /Wrapper manifest parsing fails/ }).click();
  await expect(page.getByRole('heading', { name: 'Original report', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save update', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/cxx-feedback-mobile.png', animations: 'disabled', fullPage: true });
});

test('administrator can release an active claim with a reason', async ({ page }) => {
  const context = await fixture(page);
  context.claim();
  await page.goto('/admin/reports');
  await page.getByLabel('Filter status', { exact: true }).selectOption('in_progress');
  await page.getByRole('button', { name: /Wrapper manifest parsing fails/ }).click();
  await page.getByLabel('Release reason').fill('Handing off to another agent');
  await page.getByRole('button', { name: 'Force release', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Force release', exact: true })).toHaveCount(0);
  expect(context.writes[0]).toEqual({ path: `/admin/feedback/${id}/claim`, body: { action: 'force_release', reason: 'Handing off to another agent' } });
});

test('the top bar shows unhandled reports and links to them', async ({ page }) => {
  await fixture(page);
  await page.goto('/admin/dashboard');
  const badge = page.getByRole('link', { name: '1 unhandled report' });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page).toHaveURL(/\/admin\/reports$/);
});

test('the indicator stays hidden without feedback.read', async ({ page }) => {
  await fixture(page, false);
  await page.route('**/admin/auth/status', (route) => route.fulfill({ json: { authenticated: true, enforced: true, user: { id: 2, username: 'viewer', roles: ['viewer'] }, capabilities: ['admin.read'] } }));
  await page.goto('/admin/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /unhandled report/ })).toHaveCount(0);
});
