import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { installFixtures } from './admin-fixtures';
const engines = ['codex', 'claude', 'grok', 'kimi'] as const;
for (const width of [320, 390, 768, 1440, 1920]) for (const dark of [false, true]) {
  test(`RTK saving and accessible layout ${width} ${dark ? 'dark' : 'light'}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    const policies = Object.fromEntries(engines.map(engine => [engine, { enabled: false, fleet: false, override: null, source: 'fleet', adapter_mode:'instructions', policy_revision: 'rev-1' }]));
    const writes: unknown[] = [];
    await installFixtures(page, (path, body) => {
      if (path === '/admin/rtk') return { engines: policies };
      const engine = path.split('/').at(-1)!;
      if (path.startsWith('/admin/rtk/') && body) {
        writes.push(body);
        const enabled = (body as {enabled: boolean}).enabled;
        policies[engine] = { ...policies[engine], enabled, fleet: enabled };
        return policies[engine];
      }
      return undefined;
    });
    await page.goto('/admin/settings#rtk');
    const section = page.locator('#rtk');
    await expect(section.getByRole('heading', { name: 'Command output filtering' })).toBeVisible();
    for (const engine of engines) await expect(section.getByRole('switch', { name: `${engine} output filtering` })).toBeVisible();
    await section.getByRole('switch', { name: 'codex output filtering' }).click();
    await expect(section.getByRole('switch', { name: 'codex output filtering' })).toBeChecked();
    await expect(section).toContainText('Saved. Applies to new sessions after host sync.');
    expect(writes).toEqual([{ enabled: true }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include('#rtk').analyze()).violations).toEqual([]);
    await mkdir('/tmp/rtk-review', { recursive: true });
    await page.screenshot({ fullPage: true, path: `/tmp/rtk-review/settings-${width}-${dark ? 'dark' : 'light'}.png` });
  });
}
for (const dark of [false, true]) test(`RTK host inheritance, unavailable status and keyboard ${dark}`, async ({ page }) => {
  await page.setViewportSize({width: dark ? 390 : 1440, height:900});
  await page.emulateMedia({colorScheme:dark ? 'dark':'light'});
  const policies = Object.fromEntries(engines.map(engine => [engine, {enabled:true,fleet:true,override:null,source:'fleet',adapter_mode:'instructions',policy_revision:'r1',assigned:true,observation:engine === 'codex' ? {engine,ready:true,wrapper_version:'0.9.169',native_version:'test',rtk_version:'1.2.0',policy_revision:'old',observed_at:new Date().toISOString()}:null}]));
  const writes: unknown[] = [];
  await installFixtures(page,(path,body) => {
    if(path === '/admin/hosts/1/rtk') return {engines:policies};
    if(path.startsWith('/admin/hosts/1/rtk/') && body) {
      writes.push(body); const engine=path.split('/').at(-1)!;
      const enabled=(body as {enabled:boolean|null}).enabled;
      policies[engine]={...policies[engine],enabled:enabled ?? true,override:enabled,source:enabled === null ? 'fleet':'host'};
      return policies[engine];
    }
    return undefined;
  });
  await page.goto('/admin/hosts/1');
  const section=page.locator('#host-rtk');
  await expect(section).toContainText('Previous policy reported; awaiting sync');
  await expect(section).toContainText('Not reported');
  const select=section.getByRole('button',{name:'claude output filtering'});
  await select.focus(); await page.keyboard.press('Enter');
  await page.getByRole('option',{name:'Disabled',exact:true}).click();
  await expect(select).toContainText('Disabled');
  await expect(section.getByTestId('rtk-claude')).toContainText('Host override');
  await select.click(); await page.getByRole('option',{name:'Inherit',exact:true}).click();
  await expect(select).toContainText('Inherit');
  expect(writes).toEqual([{enabled:false},{enabled:null}]);
  expect((await new AxeBuilder({page}).include('#host-rtk').analyze()).violations).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('/tmp/rtk-review',{recursive:true});
  await page.screenshot({fullPage:true,path:`/tmp/rtk-review/host-${dark?'dark':'light'}.png`});
});
test('RTK failed save retains requested change and reconciles before retry', async ({page}) => {
  const policies=Object.fromEntries(engines.map(engine=>[engine,{enabled:false,fleet:false,override:null,source:'fleet',policy_revision:null}]));
  await installFixtures(page,(path)=>path === '/admin/rtk'?{engines:policies}:undefined);
  await page.route('**/admin/rtk/codex', route=>route.fulfill({status:503,json:{status:'error',message:'Temporarily unavailable'}}));
  await page.goto('/admin/settings#rtk');
  const row=page.getByTestId('rtk-codex');
  await row.getByRole('switch').click();
  await expect(row).toContainText('Save unconfirmed: Temporarily unavailable');
  await expect(row).toContainText('Requested: Enabled');
  await expect(row.getByRole('switch')).not.toBeChecked();
  await expect(row.getByRole('button',{name:'Retry change'})).toBeEnabled();
});
test('RTK load failure provides recovery without claiming disabled', async ({page})=>{
  await installFixtures(page);
  await page.route('**/admin/rtk',route=>route.fulfill({status:403,json:{status:'error',message:'Permission denied'}}));
  await page.goto('/admin/settings#rtk');
  await expect(page.locator('#rtk')).toContainText('Could not refresh output filtering: Permission denied');
  await expect(page.locator('#rtk').getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Reload output filtering'})).toBeVisible();
});
test('RTK retry stays disabled until authoritative reconciliation succeeds',async({page})=>{
 let failed=false;
 const policies=Object.fromEntries(engines.map(engine=>[engine,{enabled:false,fleet:false,override:null,source:'fleet',policy_revision:null}]));
 await installFixtures(page);
 await page.route('**/admin/rtk',route=>route.fulfill(failed ? {status:503,json:{status:'error',message:'Snapshot unavailable'}}:{json:{status:'ok',data:{engines:policies}}}));
 await page.route('**/admin/rtk/codex',route=>{failed=true;return route.fulfill({status:503,json:{status:'error',message:'Write unconfirmed'}});});
 await page.goto('/admin/settings#rtk');
 await page.getByTestId('rtk-codex').getByRole('switch').click();
 await expect(page.locator('#rtk')).toContainText('Retained policies may be stale; editing is paused.',{timeout:15000});
 await expect(page.getByTestId('rtk-codex').getByRole('button',{name:'Retry change'})).toBeDisabled();
 failed=false;
 await page.getByRole('button',{name:'Reload output filtering'}).click();
 await expect(page.getByTestId('rtk-codex').getByRole('button',{name:'Retry change'})).toBeEnabled();
});
test('RTK external policy changes refresh through shared owner events', async ({page})=>{
 const {installOwnerUpdates}=await import('./owner-stream');
 let enabled=false;
 await installFixtures(page,(path)=>path === '/admin/rtk'?{engines:Object.fromEntries(engines.map(engine=>[engine,{enabled,fleet:enabled,override:null,source:'fleet',policy_revision:enabled?'r2':'r1'}]))}:undefined);
 const emit=await installOwnerUpdates(page);
 await page.goto('/admin/settings#rtk');
 const toggle=page.locator('#rtk').getByRole('switch',{name:'grok output filtering'});
 await expect(toggle).not.toBeChecked();
 enabled=true; await emit('settings.changed');
 await expect(toggle).toBeChecked();
});
test('RTK readiness ages locally while an idle host page remains open', async ({page})=>{
 await page.clock.install({time:new Date('2026-11-08T12:00:00Z')});
 const policies=Object.fromEntries(engines.map(engine=>[engine,{enabled:true,fleet:true,override:null,source:'fleet',adapter_mode:'instructions',policy_revision:'r1',assigned:true,observation:{engine,ready:true,wrapper_version:'x',native_version:'x',rtk_version:'1.2.0',policy_revision:'r1',observed_at:'2026-11-07T12:00:05Z'}}]));
 await installFixtures(page,(path)=>path === '/admin/hosts/1/rtk'?{engines:policies}:undefined);
 await page.goto('/admin/hosts/1');
 const row=page.getByTestId('rtk-codex');
 await expect(row).toContainText('Guidance prepared at last report');
 await page.clock.runFor(30_000);
 await expect(row).toContainText('Report older than 24 hours; readiness unknown');
 await expect(row.getByRole('button',{name:'codex output filtering'})).toHaveAccessibleDescription(/Enabled.*Fleet default.*Instruction mode.*older than 24 hours/);
});
