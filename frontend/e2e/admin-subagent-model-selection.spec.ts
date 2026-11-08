import { expect, test } from '@playwright/test';
import { installFixtures } from './admin-fixtures';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`subagent selection saves and reloads at phone width in ${colorScheme}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, colorScheme });
    const page = await context.newPage();
    let enabled = false;
    await installFixtures(page, (path, body) => {
      if (path === '/admin/theme') return { theme: colorScheme };
      if (path !== '/admin/subagent-model-selection') return undefined;
      if (body) enabled = (body as { enabled: boolean }).enabled;
      return { enabled };
    });
    await page.goto('/admin/settings#agents');
    const toggle = page.getByRole('switch', { name: 'Choose models for delegated work' });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect.poll(() => enabled).toBe(true);
    await expect(toggle).toBeChecked();
    await page.reload();
    await expect(toggle).toBeChecked();
    expect(await page.locator('main').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
    await page.locator('#subagent-model-selection').screenshot({ path: `/tmp/cxx-subagent-${colorScheme}.png` });
    await context.close();
  });
}
