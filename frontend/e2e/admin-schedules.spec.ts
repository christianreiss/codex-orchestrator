import { expect, test, type Page } from '@playwright/test';
const target='agent:11111111-1111-4111-8111-111111111111';
const id='22222222-2222-4222-8222-222222222222';
async function fixture(page:Page, manage=true) {
 const calls:Array<{method:string;body:any}>=[];
 let schedule:any=null;
 await page.route('**/admin/**',route=>{
  const req=route.request(); if(!req.headers().accept?.includes('application/json')) return route.continue();
  const path=new URL(req.url()).pathname;
  const json=(body:unknown,status=200)=>route.fulfill({status,json:body});
  if(path==='/admin/auth/status') return json({authenticated:true,enforced:true,user:{id:1,username:'operator',roles:['owner']},capabilities:['admin.read','agent_messaging.read',...(manage?['agent_messaging.manage']:[])]});
  if(path==='/admin/setup/status')return json({setup_complete:true,critical_complete:true,checks:[],next_actions:[],wizard:{completed_at:new Date().toISOString(),dismissed_at:null}});
  if(path==='/admin/ws/info')return json({enabled:false});
  if(path==='/admin/agent-messaging/addresses')return json({addresses:[{id:target.slice(6),address:target,alias:'Review agent',engine:'codex',username:'chris',fqdn:'host.example',host_id:1}]});
  if(path==='/admin/schedules' && req.method()==='GET')return json({schedules:schedule?[schedule]:[],next_cursor:null});
  if(path==='/admin/schedules' && req.method()==='POST') {
   const body=req.postDataJSON();calls.push({method:req.method(),body});schedule={...body,id,version:1,next_due_at:'2026-10-08T12:05:00Z',created_by:'admin:1',updated_by:'admin:1'};return json({schedule,runs:[]});
  }
  if(path==='/admin/schedules/'+id && req.method()==='GET')return json({schedule,runs:[{id:'run',due_at:'2026-10-08T12:00:00Z',status:'capacity_wait',recovery_count:1,last_error:'schedule_capacity',next_attempt_at:'2026-10-08T12:05:00Z'}]});
  if(path==='/admin/schedules/'+id && req.method()==='PATCH') {const body=req.postDataJSON();calls.push({method:req.method(),body});schedule={...schedule,...body,version:schedule.version+1};return json({schedule,runs:[]});}
  if(path==='/admin/schedules/'+id && req.method()==='DELETE'){calls.push({method:req.method(),body:req.postDataJSON()});schedule=null;return json({deleted:true});}
  return json({});
 });
 return calls;
}
test('create, inspect, pause, edit and delete an explicit persistent interval',async({page})=>{
 const calls=await fixture(page);
 await page.goto('/admin/schedules');
 await expect(page.getByRole('heading',{name:'Wake / Cron',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Create schedule'}).click();
 await expect(page.getByRole('checkbox',{name:/Persistent recovery/})).not.toBeChecked();
 await page.getByLabel('Name',{exact:true}).fill('Continue review');
 await page.getByLabel('Target agent').selectOption(target);
 await page.getByLabel('Prompt',{exact:true}).fill('Continue the task');
 await page.getByRole('checkbox',{name:/Persistent recovery/}).check();
 await page.getByLabel('Progress timeout in seconds').fill('120');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByRole('cell',{name:'Continue review'})).toBeVisible();
 expect(calls[0].body).toMatchObject({kind:'interval',interval_minutes:5,persistent:true,progress_timeout_seconds:120,timezone:'Europe/Berlin',target});
 await page.getByRole('button',{name:'View',exact:true}).click();
 await expect(page.getByText('capacity_wait · 1 recoveries')).toBeVisible();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await expect(page.getByRole('button',{name:'Enable',exact:true})).toBeVisible();
 expect(calls[1].body).toEqual({version:1,enabled:false});
 await page.getByRole('button',{name:'Edit',exact:true}).click();
 await page.getByLabel('Name',{exact:true}).fill('Updated review');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByRole('cell',{name:/Updated review/})).toBeVisible();
 expect(calls[2].body.version).toBe(2);
 await page.getByRole('button',{name:'Delete',exact:true}).click();
 await expect(page.getByText('No schedules on this page.')).toBeVisible();
 expect(calls[3]).toEqual({method:'DELETE',body:{version:3}});
});
test('read-only users have no scheduling mutations on mobile',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page,false);await page.goto('/admin/schedules');
 await expect(page.getByRole('heading',{name:'Wake / Cron',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Create schedule'})).toHaveCount(0);
});
