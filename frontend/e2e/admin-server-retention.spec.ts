import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fixture, installFixtures } from './admin-fixtures';
import { installOwnerUpdates } from './owner-stream';

test('saved policy, preview, confirmation and pushed completion agree', async ({page}) => {
  const state = fixture('/admin/server-retention');
  const writes: Array<Record<string,unknown>> = [];
  await installFixtures(page,(path,body)=>{
    if (path==='/admin/server-retention') {
      if (body) { writes.push(body as Record<string,unknown>); state.policy=(body as {policy:unknown}).policy; state.revision='retention-fixture-v2'; }
      return {...state};
    }
    if (path==='/admin/server-retention/preview') return {revision:state.revision,observed_at:'2026-10-24T20:00:00Z',families:{auditlogs:{eligible:37,retained:12},adminaudit:{eligible:5,retained:4},quota:{eligible:9,retained:3},receipts:{eligible:2,retained:8}},history:{sessions:3,messages:5,note:'Live work and references are checked again before deletion.'}};
    if (path==='/admin/server-retention/run') {
      writes.push(body as Record<string,unknown>);
      state.run={id:(body as {client_request_id:string}).client_request_id,status:'running',counts:{}};
      return state.run as Record<string,unknown>;
    }
  });
  const emit=await installOwnerUpdates(page);
  await page.goto('/admin/settings#retention');
  const panel=page.getByRole('region',{name:'Server history'});
  await expect(panel.getByLabel('Audit history (days)')).toHaveValue('14');
  await panel.getByLabel('Audit history (days)').fill('10');
  await expect(panel.getByRole('button',{name:'Preview eligible history'})).toBeDisabled();
  await panel.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(panel.getByText('Effective policy loaded')).toBeVisible();
  expect(writes[0]).toMatchObject({policy:{audit_days:10,history_hours:24,quota_days:7},expected_revision:'retention-fixture-v1'});
  await panel.getByRole('button',{name:'Preview eligible history'}).click();
  await expect(panel.getByRole('table')).toContainText('37');
  await panel.getByRole('button',{name:'Delete eligible history',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('No database or storage backup');
  await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
  await dialog.getByRole('button',{name:'Delete eligible server history',exact:true}).click();
  await expect(panel.getByText(/Cleanup running/)).toBeVisible();
  expect(writes[1]).toMatchObject({expected_revision:'retention-fixture-v2'});
  state.run={...(state.run as object),status:'completed',counts:{auditlogs:37,adminaudit:5},completed_at:'2026-10-24T20:01:00Z'};
  await emit('settings.changed',{key:'server_retention_run_v1'});
  await expect(panel.getByText(/Cleanup completed: 42/)).toBeVisible();
  await expect(panel).toContainText('does not guarantee deletion after a number of days');
});

test('failed saves keep the draft and mobile settings remain accessible',async({page})=>{
  await installFixtures(page);
  await page.route('**/admin/server-retention',route=>route.request().method()==='POST'
    ? route.fulfill({status:409,json:{status:'error',code:'retention_policy_changed',message:'Retention policy changed; reload the effective policy'}})
    : route.fulfill({json:{status:'ok',data:fixture('/admin/server-retention')}}));
  await page.setViewportSize({width:320,height:844});
  await page.goto('/admin/settings#retention');
  const panel=page.getByRole('region',{name:'Server history'});
  await expect(panel.getByLabel('Audit history (days)')).toHaveValue('14');
  await panel.getByLabel('Audit history (days)').fill('9');
  await panel.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(panel.getByRole('alert')).toContainText('Retention policy changed');
  await expect(panel.getByLabel('Audit history (days)')).toHaveValue('9');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const axe=await new AxeBuilder({page}).include('[aria-labelledby="server-retention-title"]').analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({path:'test-results/server-retention-mobile.png',fullPage:true});
});

test('read-only dark desktop exposes limits without offering deletion',async({page})=>{
  await installFixtures(page,(path)=>{
    if(path==='/admin/auth/status')return {...fixture(path),roles:['viewer'],capabilities:['settings.read']};
    if(path==='/admin/theme')return {theme:'system'};
    if(path==='/admin/server-retention/preview')return {revision:'retention-fixture-v1',observed_at:'2026-10-24T20:00:00Z',families:{auditlogs:{eligible:12,retained:3}},history:{sessions:1,messages:2,note:'Protected records remain.'}};
  });
  await page.emulateMedia({colorScheme:'dark'});
  await page.addInitScript(()=>localStorage.setItem('codex.theme','dark'));
  await page.setViewportSize({width:1440,height:1080});
  await page.goto('/admin/settings#retention');
  const panel=page.getByRole('region',{name:'Server history'});
  await expect(panel.getByLabel('Audit history (days)')).toBeDisabled();
  await panel.getByRole('button',{name:'Preview eligible history'}).click();
  await expect(panel.getByRole('button',{name:'Delete eligible history',exact:true})).toBeDisabled();
  await expect(page.locator('html')).toHaveClass(/dark/);
  const axe=await new AxeBuilder({page}).include('[aria-labelledby="server-retention-title"]').analyze();
  expect(axe.violations).toEqual([]);
  await panel.screenshot({path:'test-results/server-retention-desktop-dark.png'});
});
