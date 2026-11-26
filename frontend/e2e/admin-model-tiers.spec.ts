import { expect, test, type Page } from '@playwright/test';
import { installFixtures } from './admin-fixtures';

const LEVELS = [1, 2, 3, 4, 5].map((tier) => ({ tier, work: `Typical work of tier ${tier}` }));
const CATALOG = [
  { engine: 'codex', id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', family: 'sol', status: 'active', default_tier: 3 },
  { engine: 'codex', id: 'gpt-6-luna', label: 'GPT-6 Luna', family: 'luna', status: 'active', default_tier: 1 },
  { engine: 'claude', id: 'claude-fable-5-2', label: 'Fable 5.2', family: 'fable', status: 'active', default_tier: 5 },
  { engine: 'claude', id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus', status: 'active', default_tier: 4 },
  { engine: 'claude', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet', status: 'active', default_tier: 3 },
  { engine: 'grok', id: 'grok-4.7', label: 'Grok 4.7', family: 'grok', status: 'active', default_tier: 2 },
] as const;

/** A stand-in for `/admin/model-tiers`: stores what the console posts, as the server does. */
async function serve(page: Page, opts: { manage?: boolean; saved?: Record<string, Record<string, number>> } = {}) {
  const posts: Record<string, Record<string, number>>[] = [];
  let placed: Record<string, Record<string, number>> = opts.saved ?? {};
  const view = () => ({
    levels: LEVELS,
    models: CATALOG.map((m) => ({ ...m, tier: placed[m.engine]?.[m.id] ?? m.default_tier })),
    updated_at: Object.keys(placed).length ? '2026-11-26T10:00:00Z' : null,
  });
  await installFixtures(page, (path, body) => {
    if (path === '/admin/auth/status') {
      return { authenticated: true, enforced: true, user: { id: 1, username: 'operator', roles: ['owner'] },
        capabilities: ['admin.read', 'settings.read', ...(opts.manage === false ? [] : ['settings.manage'])] };
    }
    if (path === '/admin/engines/state') {
      return { engines: ['codex', 'claude', 'grok', 'kimi'].map((engine) => ({ engine, label: engine, enabled: engine !== 'grok' })) };
    }
    if (path !== '/admin/model-tiers') return undefined;
    if (body) {
      const tiers = (body as { tiers: Record<string, Record<string, number>> }).tiers;
      posts.push(tiers);
      placed = Object.fromEntries(Object.entries(tiers).map(([engine, models]) => [engine,
        Object.fromEntries(Object.entries(models).filter(([id, tier]) => CATALOG.find((m) => m.id === id)?.default_tier !== tier))]));
    }
    return view();
  });
  return posts;
}

const column = (page: Page, tier: number) => page.getByTestId(`tier-column-${tier}`);
const card = (page: Page, key: string) => page.locator(`[data-testid="tier-model"][data-model="${key}"]`);

test('drags a model to another tier, keeps hidden engines and saves only on request', async ({ page }) => {
  // Grok's placement is stored while Grok is switched off: the board hides it but must send it back.
  const posts = await serve(page, { saved: { grok: { 'grok-4.7': 3 } } });
  await page.goto('/admin/settings?group=agents#model-tiers');
  await expect(column(page, 3).getByText('Sonnet 5.5')).toBeVisible();
  await expect(page.getByText('Grok 4.7')).toHaveCount(0);
  await expect(page.getByText(/1 item from switched-off engines is hidden/)).toBeVisible();

  await card(page, 'claude:claude-sonnet-5-5').dragTo(column(page, 4));
  await expect(column(page, 4).getByText('Sonnet 5.5')).toBeVisible();
  await expect(card(page, 'claude:claude-sonnet-5-5')).toContainText('unsaved, was Tier 3');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  expect(posts).toEqual([]);

  await page.getByRole('button', { name: 'Save tiers' }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    codex: { 'gpt-6.2-sol': 3, 'gpt-6-luna': 1 },
    claude: { 'claude-fable-5-2': 5, 'claude-opus-5-5': 4, 'claude-sonnet-5-5': 4 },
    grok: { 'grok-4.7': 3 },
  });
  await expect(card(page, 'claude:claude-sonnet-5-5')).toContainText('default Tier 3');
  await expect(page.getByRole('button', { name: 'Save tiers' })).toBeDisabled();

  await page.reload();
  await expect(column(page, 4).getByText('Sonnet 5.5')).toBeVisible();
});

test('moves a model without dragging and resets it to the default', async ({ page }) => {
  const posts = await serve(page, { saved: { claude: { 'claude-opus-5-5': 5 } } });
  await page.goto('/admin/settings?group=agents#model-tiers');
  await expect(column(page, 5).getByText('Opus 5.5')).toBeVisible();

  await page.getByRole('button', { name: 'Move Codex GPT-6 Luna' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Tier 2' }).click();
  await expect(column(page, 2).getByText('GPT-6 Luna')).toBeVisible();

  await page.getByRole('button', { name: 'Move Claude Opus 5.5' }).click();
  await page.getByRole('menuitem', { name: 'Reset to default (Tier 4)' }).click();
  await expect(column(page, 4).getByText('Opus 5.5')).toBeVisible();
  await expect(card(page, 'codex:gpt-6-luna')).toContainText('unsaved, was Tier 1');
  await expect(card(page, 'claude:claude-opus-5-5')).toContainText('unsaved, was Tier 5');

  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(column(page, 1).getByText('GPT-6 Luna')).toBeVisible();
  await expect(column(page, 5).getByText('Opus 5.5')).toBeVisible();

  await page.getByRole('button', { name: 'Reset all to defaults' }).click();
  await page.getByRole('button', { name: 'Save tiers' }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]!.claude).toEqual({ 'claude-fable-5-2': 5, 'claude-opus-5-5': 4, 'claude-sonnet-5-5': 3 });
  await expect(page.getByRole('button', { name: 'Reset all to defaults' })).toBeDisabled();
});

test('is read-only without settings.manage and reflows at phone width', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 844 } });
  const page = await context.newPage();
  await serve(page, { manage: false });
  await page.goto('/admin/settings?group=agents#model-tiers');
  await expect(column(page, 3).getByText('Sonnet 5.5')).toBeVisible();
  await expect(page.getByText(/Read-only: moving models between tiers requires/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Move / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save tiers' })).toHaveCount(0);
  await expect(card(page, 'claude:claude-sonnet-5-5')).toHaveAttribute('draggable', 'false');
  expect(await page.locator('main').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
  await context.close();
});
