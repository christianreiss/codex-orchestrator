import { expect, test } from '@playwright/test';
test('speech defaults and native limitations', async ({ page }) => {
  await page.route('**/admin/**', route => {
    if (!route.request().headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if(path === '/admin/auth/status') body={authenticated:true,enforced:true,user:{id:1,username:'operator',roles:['owner']},capabilities:['admin.read','settings.read','settings.manage']};
    if(path === '/admin/setup/status') body={setup_complete:true,critical_complete:true,checks:[],next_actions:[],wizard:{completed_at:'2026-11-12T00:00:00Z'}};
    if(path === '/admin/ws/info') body={enabled:false};
    if(path === '/admin/speech-input') body={engines:Object.fromEntries(['codex','claude','grok','kimi'].map(e=>[e,{enabled:true,global:true,override:null,supported:e!=='kimi'}]))};
    return route.fulfill({json:body});
  });
  await page.goto('/admin/settings?group=rollout#speech-input');
  const area=page.locator('#speech-input');
  await expect(area).toContainText('Global default');
  await expect(area).toContainText('Native speech input is not supported');
  for(const width of [1440,390]) { await page.setViewportSize({width,height:1000}); await area.screenshot({path:`test-results/speech-${width}.png`}); }
});
