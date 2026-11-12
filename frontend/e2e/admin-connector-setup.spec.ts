import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installFixtures } from './admin-fixtures';

const scope = { categories: { hosts: 'ro', projects: 'ro' }, tools: [], hosts: [], projects: [], global: false, sensitive: [] };
const policy = { enabled: true, providers: { chatgpt: true, claude: true, grok: true, kimi: true }, ceiling: scope };
const config = { policy, can_manage: true, issuer: 'https://connector.example', mcp_url: 'https://connector.example/connectors/mcp', ready: true, hosts: [{ id: 1, name: 'test-host' }], projects: ['test-project'], catalog: [] };
const connection = { id: 'connection-1', provider: 'chatgpt', userId: 1, createdAt: '2026-11-09T00:00:00Z', last_call_at: null, operations: ['host_list'], scope };

test.beforeEach(async ({ page }) => {
  await installFixtures(page, (path, body) => {
    if (path === '/admin/theme') return { theme: 'system' };
    if (path === '/admin/connectors/config') return config;
    if (path === '/admin/connectors/connections') return { connections: [connection] };
    if (path === '/admin/connectors/clients') return { client_id: 'client-1' };
    if (path === '/admin/connectors/consent/request-1') return body ? { redirect: '/admin/connectors' } : { client: { name: 'Test app', provider: 'chatgpt' }, csrf: 'test' };
    if (path === '/admin/connectors/preview') return { scope: body, operations: ['host_list'] };
    return undefined;
  });
});

for (const theme of ['light', 'dark'] as const) for (const width of [320, 1440]) {
  test(`setup reflow and accessibility ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(t => localStorage.setItem('codex.theme', t), theme);
    await page.goto('/admin/connectors');
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
    else await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expect(page.getByText('Configuration ready.', { exact: false })).toBeVisible();
    for (const provider of ['ChatGPT', 'Claude', 'Grok']) {
      await page.getByRole('button', { name: provider, exact: true }).click();
      await expect(page.getByRole('button', { name: provider, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText('https://connector.example/connectors/mcp', { exact: true })).toBeVisible();
      expect(await page.locator('main').evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(2);
    }
    await page.getByRole('button', { name: 'ChatGPT', exact: true }).click();
    await page.screenshot({ path: info.outputPath(`setup-${theme}-${width}.png`), fullPage: true });
    const results = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
    expect(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  });
}

test('copy, manual registration, policy and revoke', async ({ page, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/admin/connectors');
  await page.getByRole('button', { name: 'Copy Name' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Orchestrator');
  await page.getByText('Manual OAuth client setup').click();
  await page.getByLabel('Callback URL').screenshot({ path: info.outputPath('manual.png') });
  await page.getByLabel('Callback URL').fill('https://app.example/callback');
  await page.getByRole('button', { name: 'Create client ID' }).click();
  await expect(page.getByText('Client ID created:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Copy client ID' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('client-1');
  await page.getByRole('button', { name: 'Edit policy' }).click();
  await page.getByLabel('hosts access').screenshot({ path: info.outputPath('policy.png') });
  await page.getByLabel('hosts access').selectOption('rw');
  await page.getByLabel('test-host').check();
  await page.getByLabel('test-project').check();
  await page.getByLabel('Allow fleet-wide shared data').check();
  await page.getByLabel('secrets.metadata').check();
  await page.getByLabel('Restrict to tool names', { exact: false }).fill('host_list');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByText('Connector policy saved')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Connection revoked')).toBeVisible();
});

test('consent scope must be reviewed before authorization and can be denied', async ({ page }) => {
  await page.goto('/admin/connectors?request=request-1');
  await expect(page.getByText('Test app')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Authorize connection' })).toBeDisabled();
  await page.getByLabel('test-host').check();
  await page.getByLabel('test-project').check();
  await page.getByRole('button', { name: 'Review effective permissions' }).click();
  await expect(page.getByText('Effective access:', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Authorize connection' })).toBeEnabled();
  await page.getByLabel('Allow fleet-wide shared data').check();
  await expect(page.getByRole('button', { name: 'Authorize connection' })).toBeDisabled();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page).toHaveURL(/\/admin\/connectors$/);
});

test('registration errors retain callback and policy cancel discards changes', async ({ page }) => {
  await page.route('**/admin/connectors/clients', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: 'Invalid callback' }) }));
  await page.goto('/admin/connectors');
  await page.getByText('Manual OAuth client setup').click();
  await page.getByLabel('Callback URL').fill('https://app.example/callback');
  await page.getByRole('button', { name: 'Create client ID' }).click();
  await expect(page.getByText('Client creation failed:', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Callback URL')).toHaveValue('https://app.example/callback');
  await page.getByRole('button', { name: 'Edit policy' }).click();
  await page.getByLabel('Enable grok').uncheck();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Edit policy' }).click();
  await expect(page.getByLabel('Enable grok')).toBeChecked();
});

test('authorization submits the reviewed permissions', async ({ page }, info) => {
  let submitted: any;
  await page.route('**/admin/connectors/consent/request-1', route => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON();
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ redirect: '/admin/connectors' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ client: { name: 'Test app', provider: 'chatgpt' }, csrf: 'test' }) });
  });
  await page.goto('/admin/connectors?request=request-1');
  await page.getByLabel('test-host').check();
  await page.getByRole('button', { name: 'Review effective permissions' }).click();
  await expect(page.getByRole('button', { name: 'Authorize connection' })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('consent.png'), fullPage: true });
  await page.getByRole('button', { name: 'Authorize connection' }).click();
  await expect(page).toHaveURL(/\/admin\/connectors$/);
  expect(submitted.approve).toBe(true);
  expect(submitted.scope.hosts).toEqual([1]);
});
