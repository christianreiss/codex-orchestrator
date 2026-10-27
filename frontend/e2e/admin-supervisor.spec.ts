import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const target='agent:11111111-1111-4111-8111-111111111111';
async function fixture(page:Page,manage=true,ambiguous=false) {
 let enabled=false,writes=0,paused=false;
 const view=()=>({enabled,effective:enabled,dependencies:[],states:[{target,taskKey:'integration',state:'waiting_agent',reason:'Waiting for the test worker',waitingForAddressId:'22222222-2222-4222-8222-222222222222',waitingForMessageId:null,lastProgressAt:'2026-10-27T12:00:00Z',reminderAt:null,deadlineAt:'2026-10-27T14:00:00Z',paused:paused?1:0,escalation:null,version:1,attempts:2,nextAttemptAt:'2026-10-27T13:00:00Z',watchdogId:'fixture'}]});
 await page.route('**/admin/**',async route=>{
  const req=route.request();if(!req.headers().accept?.includes('application/json'))return route.continue();
  const path=new URL(req.url()).pathname,json=(body:unknown,status=200)=>route.fulfill({status,json:body});
  if(path==='/admin/auth/status')return json({authenticated:true,enforced:true,user:{id:1,username:'operator',roles:['viewer']},capabilities:['admin.read','settings.read','agent_messaging.read',...(manage?['agent_messaging.manage']:[])]});
  if(path==='/admin/setup/status')return json({setup_complete:true,critical_complete:true,checks:[],next_actions:[],wizard:{completed_at:'2026-10-21T08:00:00Z',dismissed_at:null}});
  if(path==='/admin/ws/info')return json({enabled:false});
  if(path==='/admin/agent-supervisor')return json(view());
  if(path==='/admin/agent-supervisor/state'){writes++;enabled=req.postDataJSON().enabled;return ambiguous?json({message:'Response lost'},500):json(view());}
  if(path==='/admin/agent-supervisor/pause'){paused=true;return json(view());}
  if(path==='/admin/agent-messaging/scopes/state')return json({enabled:false});
  if(path==='/admin/overview')return json({inactivity_window_days:30});
  return json({});
 });
 return {writes:()=>writes};
}
test('supervision confirms an ambiguous save and pauses the selected incident',async({page})=>{
 const state=await fixture(page,true,true);await page.goto('/admin/settings#agent-supervisor');
 const area=page.locator('#agent-supervisor'),toggle=area.getByRole('switch',{name:'Enable fleet supervision'});
 await expect(toggle).toBeEnabled();await toggle.click();await expect(toggle).toBeChecked();
 await expect(area).toContainText('Saved. Confirmed by the server.');expect(state.writes()).toBe(1);
 await expect(area).toContainText('2 / 5');await expect(area).toContainText('Waiting for the test worker');
 await area.getByRole('button',{name:'Pause recovery'}).click();await expect(area).toContainText('Recovery paused');
});
test('read-only supervision keeps the recovery limits and permission boundary visible',async({page})=>{
 await fixture(page,false);await page.goto('/admin/settings#agent-supervisor');const area=page.locator('#agent-supervisor');
 await expect(area.getByRole('switch')).toBeDisabled();await expect(area.getByRole('button',{name:'Pause recovery'})).toBeDisabled();
 await expect(area).toContainText('five times within two hours');await expect(area).toContainText('Read only.');
});
for(const theme of ['light','dark'])test(`supervisor reflows at 320px in ${theme}`,async({page})=>{
 await page.setViewportSize({width:320,height:844});await page.emulateMedia({colorScheme:theme as 'light'|'dark'});
 await fixture(page);await page.goto('/admin/settings#agent-supervisor');const area=page.locator('#agent-supervisor');await expect(area).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(await area.locator('dl').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth))).toBe(true);
 const axe=await new AxeBuilder({page}).include('#agent-supervisor').analyze();expect(axe.violations).toEqual([]);
 await area.screenshot({path:`test-results/supervisor-${theme}-320.png`});
});
