import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { CAPABILITIES } from '../src/lib/auth/capabilities';

const key = `sk-cdx-${'0123456789abcdef'.repeat(4)}`;
const surfaces = [
  { surface: 'openai', label: 'OpenAI-compatible', base_path: '/v1', wire: 'openai', backend: 'grok', identity_backend: 'codex', disabled: false, key_count: 0 },
  { surface: 'anthropic', label: 'Anthropic-compatible', base_path: '/anthropic/v1', wire: 'anthropic', backend: 'claude', identity_backend: 'claude', disabled: false, key_count: 0 },
  { surface: 'grok', label: 'Grok (OpenAI-compatible)', base_path: '/grok/v1', wire: 'openai', backend: 'grok', identity_backend: 'grok', disabled: false, key_count: 0 },
  { surface: 'kimi', label: 'Kimi Code (OpenAI-compatible)', base_path: '/kimi/v1', wire: 'openai', backend: 'kimi', identity_backend: 'kimi', disabled: true, key_count: 0 },
];
const PROVIDER = { openai: ['openai', 'OpenAI'], anthropic: ['anthropic', 'Anthropic'], grok: ['xai', 'xAI'], kimi: ['moonshot', 'Moonshot AI'] } as const;
type SourceOptions = {
  /** Serve the source fields; without them the rows look like an older server's. */
  sources?: Partial<Record<keyof typeof PROVIDER, 'emulated' | 'upstream'>>;
  usable?: Partial<Record<keyof typeof PROVIDER, number>>;
  sourceError?: { status: number; code: string; message: string };
  capabilities?: readonly string[];
};
async function fixture(page: Page, options: { disabledEngine?: string; failSettings?: boolean; failCreate?: boolean; hold?: boolean; longUrl?: boolean; delayedSurfaces?: boolean } & SourceOptions = {}) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sources = options.sources ? { openai: 'emulated', anthropic: 'emulated', grok: 'emulated', kimi: 'emulated', ...options.sources } as Record<string, string> : null;
  const withSource = (row: (typeof surfaces)[number]) => {
    if (!sources) return row;
    const [provider, provider_label] = PROVIDER[row.surface as keyof typeof PROVIDER];
    const usable = options.usable?.[row.surface as keyof typeof PROVIDER] ?? 0;
    return { ...row, source: sources[row.surface], provider, provider_label, provider_keys: { active: usable, usable } };
  };
  let release: (() => void) | undefined;
  let record: Record<string, unknown> | undefined;
  let recordPath = '';
  await page.route('**/admin/**', async route => {
    const req = route.request();
    if (req.resourceType() === 'document' || !req.headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(req.url()).pathname.replace(/\/admin\/engines\/active$/, "/admin/engines/state");
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (path === '/admin/auth/status') return json({ authenticated: true, enforced: true, user: { id: 1, username: 'operator', roles: ['owner'] }, capabilities: [...(options.capabilities ?? CAPABILITIES)] });
    if (path === '/admin/setup/status') return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: '2026-10-15T00:00:00Z' } });
    if (path === '/admin/ws/info') return json({ enabled: false });
    if (path === '/admin/api/surfaces') {
      if (options.delayedSurfaces) await new Promise(resolve => setTimeout(resolve, 150));
      if (options.failSettings) return json({ message: 'Connection settings unavailable' }, 503);
      return json({ surfaces: surfaces.map(withSource).map(row => options.longUrl ? { ...row, base_path: `${'/long-proxy-prefix'.repeat(8)}${row.base_path}` } : row), backends: [] });
    }
    const sourceMatch = /^\/admin\/api\/surfaces\/(\w+)\/source$/.exec(path);
    if (sourceMatch && req.method() === 'POST') {
      const body = req.postDataJSON(); writes.push({ path, body });
      if (options.sourceError) return json({ status: 'error', ...options.sourceError }, options.sourceError.status);
      if (sources) sources[sourceMatch[1]] = body.source;
      return json(withSource(surfaces.find(row => row.surface === sourceMatch[1])!));
    }
    if (path === '/admin/engines/state') return json({ engines: ['codex', 'claude', 'grok', 'kimi'].map(engine => ({ engine, label: engine === 'codex' ? 'Codex' : engine === 'claude' ? 'Claude' : engine === 'grok' ? 'Grok' : 'Kimi Code', enabled: options.disabledEngine !== engine })) });
    if (path === '/admin/api/state') return json({ disabled: false });
    if (/\/admin\/(openai|claude|grok|kimi)\/keys$/.test(path)) {
      // The key list merges the three endpoints, so each one answers only for its own keys.
      if (req.method() === 'GET') return json(record && recordPath === path ? [record] : []);
      const body = req.postDataJSON(); writes.push({ path, body });
      if (options.hold) await new Promise<void>(resolve => { release = resolve; });
      if (options.failCreate) return json({ message: 'Engine is disabled fleet-wide', code: 'engine_disabled' }, 409);
      recordPath = path;
      record = { id: 42, ...body, is_active: true, key_prefix: key.slice(0, 16), use_count: 0, created_at: '2026-10-15T00:00:00Z' };
      return json({ key, record });
    }
    return json({});
  });
  return { writes, release: () => release?.() };
}

async function chooseEngine(page: Page, label = 'Claude') {
  await page.getByRole('dialog').getByRole('button', { name: 'Engine', exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
async function assertNoOverflow(page: Page) {
  expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const format of ['openai', 'claude', 'grok', 'kimi']) {
  test(`${format}: explicitly selects an engine and copies exact connection values`, async ({ page, context }) => {
    const { writes } = await fixture(page, { delayedSurfaces: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/admin/api-keys?dialog=new&engine=${format}`);
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('CI runner');
    await expect(dialog.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled();
    await chooseEngine(page);
    await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Key created' })).toBeVisible();
    expect(writes).toEqual([{ path: `/admin/${format}/keys`, body: { name: 'CI runner', expires_at: null, backend_engine: 'claude' } }]);
    await assertNoOverflow(page);
    expect(await dialog.evaluate(el => [...el.querySelectorAll('*')].every(child => child.scrollHeight <= child.clientHeight + 1 || getComputedStyle(child).overflowY !== 'auto'))).toBe(true);
    await page.screenshot({ path: `test-results/api-access-${format}-created-desktop.png` });
    const baseUrl = `${new URL(page.url()).origin}${format === 'openai' ? '/v1' : format === 'claude' ? '/anthropic/v1' : format === 'grok' ? '/grok/v1' : '/kimi/v1'}`;
    const urls = {
      'Base URL': baseUrl, 'Models URL': `${baseUrl}/models`, 'Responses URL': `${baseUrl}/responses`,
      ...(format === 'claude' ? { 'Messages URL': `${baseUrl}/messages`, 'Completions URL': `${baseUrl}/complete` }
        : { 'Chat completions URL': `${baseUrl}/chat/completions`, 'Completions URL': `${baseUrl}/completions` }),
    };
    for (const [label, value] of Object.entries({ key, ...urls })) {
      await dialog.getByRole('button', { name: `Copy ${label}`, exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    }
    await dialog.getByText('Try a request with curl', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Copy curl example', exact: true }).click();
    const example = await page.evaluate(() => navigator.clipboard.readText());
    expect(example).toContain(format === 'claude' ? `x-api-key: ${key}` : `Authorization: Bearer ${key}`);
    expect(example).toContain(format === 'claude' ? `${baseUrl}/messages` : `${baseUrl}/chat/completions`);
    expect(example).toContain('MODEL_ID_FROM_MODELS_URL');
    if (format === 'claude') expect(example).toContain('anthropic-version: 2023-06-01');
    await assertNoOverflow(page);
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(axe.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual([]);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'Claude', exact: true })).toBeVisible();
  });
}

test('mobile wraps long keys and URLs and keeps actions available', async ({ page }) => {
  await fixture(page, { longUrl: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/api-keys?dialog=new');
  const dialog = page.getByRole('dialog');
  await assertNoOverflow(page);
  await chooseEngine(page, 'Codex');
  await dialog.getByLabel('Name', { exact: true }).fill('Mobile connection');
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Key created' })).toBeVisible();
  await assertNoOverflow(page);
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
  await dialog.getByRole('button', { name: 'Copy Responses URL', exact: true }).scrollIntoViewIfNeeded();
  await assertNoOverflow(page);
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/api-access-created-mobile.png' });
});

test('creation failures preserve the draft and disabled engines are not offered', async ({ page }) => {
  const { writes } = await fixture(page, { disabledEngine: 'grok', failCreate: true });
  await page.goto('/admin/api-keys?dialog=new');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Engine', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: /^Grok/ })).toHaveCount(0);
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Keep my draft');
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Failed to create key');
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Keep my draft');
  expect(writes).toHaveLength(1);
});

test('in-flight creation blocks dismissal and duplicate submission', async ({ page }) => {
  const state = await fixture(page, { hold: true });
  await page.goto('/admin/api-keys?dialog=new');
  const dialog = page.getByRole('dialog');
  await chooseEngine(page);
  await dialog.getByLabel('Name', { exact: true }).fill('Pending');
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Pending');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.mouse.click(3, 3);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled();
  state.release();
  await expect(dialog.getByRole('heading', { name: 'Key created' })).toBeVisible();
  expect(state.writes).toHaveLength(1);
});

test('settings failures block creation and offer retry', async ({ page }) => {
  await fixture(page, { failSettings: true });
  await page.goto('/admin/api-keys?dialog=new');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('Could not load connection settings');
  await expect(dialog.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
});

test('clipboard rejection never reports success', async ({ page }) => {
  await fixture(page);
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Clipboard denied'); } } }));
  await page.goto('/admin/api-keys?dialog=new');
  const dialog = page.getByRole('dialog');
  await chooseEngine(page);
  await dialog.getByLabel('Name', { exact: true }).fill('Copy failure');
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await dialog.getByRole('button', { name: 'Copy key', exact: true }).click();
  await expect(page.getByText('Copy failed', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Copy key', exact: true })).toHaveText('Copy key');
});


test('API format and expiration can change without changing the assigned engine', async ({ page }) => {
  const { writes } = await fixture(page);
  await page.goto('/admin/api-keys?dialog=new');
  const dialog = page.getByRole('dialog');
  await chooseEngine(page, 'Codex');
  await dialog.getByRole('button', { name: 'API format', exact: true }).click();
  await page.getByRole('option', { name: 'Anthropic-compatible', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Engine', exact: true })).toHaveText('Codex');
  await dialog.getByLabel('Name', { exact: true }).fill('Expiring connection');
  await dialog.getByRole('switch', { name: 'Set an expiration date' }).click();
  await dialog.getByLabel('Expiration date & time', { exact: true }).fill('2099-01-02T12:30');
  const expires = await page.evaluate(() => new Date('2099-01-02T12:30').toISOString());
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Key created' })).toBeVisible();
  expect(writes).toEqual([{ path: '/admin/claude/keys', body: { name: 'Expiring connection', backend_engine: 'codex', expires_at: expires } }]);
  await expect(dialog.getByRole('region', { name: 'Key details' })).toContainText('Codex');
});

// "Answered by" pins a key's source; "API default" sends none, which the tests above cover.
test('Answered by: a provider API key pin sends no engine and shows where it goes', async ({ page }) => {
  const { writes } = await fixture(page, { sources: { openai: 'emulated' }, usable: { openai: 1 } });
  await page.goto('/admin/api-keys?dialog=new&engine=openai');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Answered by', exact: true })).toHaveText('API default (Subscription)');
  await dialog.getByLabel('Name', { exact: true }).fill('Billed to OpenAI');
  await dialog.getByRole('button', { name: 'Answered by', exact: true }).click();
  await page.getByRole('option', { name: 'Provider API key', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Engine', exact: true })).toBeDisabled();
  await expect(dialog).toContainText('Always forwarded to OpenAI with a stored provider key and billed to that account.');
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Key created' })).toBeVisible();
  expect(writes).toEqual([{ path: '/admin/openai/keys', body: { name: 'Billed to OpenAI', source: 'upstream', expires_at: null } }]);
  const details = dialog.getByRole('region', { name: 'Key details' });
  await expect(details).toContainText('OpenAI API key');
  await expect(details).toContainText('Not used');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Billed to OpenAI' })).toContainText('Provider API key');
});

test('Answered by: a subscription pin keeps the chosen engine', async ({ page }) => {
  const { writes } = await fixture(page, { sources: { anthropic: 'upstream' }, usable: { anthropic: 1 } });
  await page.goto('/admin/api-keys?dialog=new&engine=claude');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Answered by', exact: true })).toHaveText('API default (API key)');
  await dialog.getByLabel('Name', { exact: true }).fill('Stays on Claude');
  await dialog.getByRole('button', { name: 'Answered by', exact: true }).click();
  await page.getByRole('option', { name: 'Subscription', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled();
  await chooseEngine(page, 'Claude');
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Key created' })).toBeVisible();
  expect(writes).toEqual([{ path: '/admin/claude/keys', body: { name: 'Stays on Claude', backend_engine: 'claude', source: 'emulated', expires_at: null } }]);
  await expect(dialog.getByRole('region', { name: 'Key details' })).toContainText('Subscription');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Stays on Claude' });
  await expect(row).toContainText('Claude');
  await expect(row).toContainText('Subscription');
});

test('Source column: switching to API key names the billing and disables the engine', async ({ page }) => {
  const { writes } = await fixture(page, { sources: { openai: 'emulated' }, usable: { openai: 1 } });
  await page.goto('/admin/api-keys#exposed-apis');
  const select = page.getByRole('button', { name: 'Source for /v1', exact: true });
  await expect(select).toHaveText('Subscription');
  await select.click();
  await page.getByRole('option', { name: 'API key', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Answer /v1 with OpenAI API keys?' })).toBeVisible();
  await expect(dialog).toContainText('billed to that OpenAI account');
  await expect(dialog).toContainText('1 usable OpenAI key');
  expect(writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Switch to API key', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([{ path: '/admin/api/surfaces/openai/source', body: { source: 'upstream' } }]);
  await expect(select).toHaveText('API key');
  await expect(page.getByRole('button', { name: 'Backend for /v1', exact: true })).toBeDisabled();
  const row = page.locator('#exposed-apis').getByRole('row').filter({ has: select });
  await expect(row).toContainText('Not used with API key');
  await expect(row).toContainText('OpenAI, 1 usable key');

  // Back to the subscription costs nothing and asks nothing.
  await select.click();
  await page.getByRole('option', { name: 'Subscription', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ path: '/admin/api/surfaces/openai/source', body: { source: 'emulated' } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Source column: no usable key blocks the switch and a server refusal stays in the dialog', async ({ page }) => {
  const { writes } = await fixture(page, { sources: { grok: 'upstream' }, usable: { openai: 1 }, sourceError: { status: 409, code: 'provider_key_missing', message: 'No usable provider key' } });
  await page.goto('/admin/api-keys#exposed-apis');
  // Already upstream without a key: the row says so and links to the fix.
  const grok = page.locator('#exposed-apis').getByRole('row').filter({ has: page.getByRole('button', { name: 'Source for /grok/v1', exact: true }) });
  await expect(grok.getByRole('link', { name: 'No usable xAI key' })).toHaveAttribute('href', '/admin/provider-keys#provider-xai');

  await page.getByRole('button', { name: 'Source for /anthropic/v1', exact: true }).click();
  await page.getByRole('option', { name: 'API key', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('No usable Anthropic key is stored, so /anthropic/v1 would answer 503.');
  await expect(dialog.getByRole('link', { name: 'Add one under Provider keys' })).toHaveAttribute('href', '/admin/provider-keys#provider-anthropic');
  await expect(dialog.getByRole('button', { name: 'Switch to API key', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes).toEqual([]);

  // The count said one key, but it went away before the switch landed.
  await page.getByRole('button', { name: 'Source for /v1', exact: true }).click();
  await page.getByRole('option', { name: 'API key', exact: true }).click();
  await dialog.getByRole('button', { name: 'Switch to API key', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('No usable OpenAI key is stored. Add one under Provider keys before switching to API key.');
  await expect(dialog.getByRole('heading', { name: 'Answer /v1 with OpenAI API keys?' })).toBeVisible();
  expect(writes).toEqual([{ path: '/admin/api/surfaces/openai/source', body: { source: 'upstream' } }]);
});

test('Source column is read-only without keys.manage', async ({ page }) => {
  await fixture(page, { sources: {}, capabilities: CAPABILITIES.filter(c => c !== 'keys.manage') });
  await page.goto('/admin/api-keys#exposed-apis');
  await expect(page.getByRole('button', { name: 'Source for /v1', exact: true })).toBeDisabled();
});

test('the endpoint summary judges an API key source by its provider keys', async ({ page }) => {
  await fixture(page, { sources: { openai: 'upstream', grok: 'upstream' }, usable: { openai: 2 } });
  await page.goto('/admin/api-keys');
  await page.getByRole('button', { name: 'API endpoints', exact: true }).click();
  await expect(page.locator('[data-endpoint="openai"]')).toContainText('Enabled, API key');
  await expect(page.locator('[data-endpoint="grok"]')).toContainText('No usable provider key');
});
