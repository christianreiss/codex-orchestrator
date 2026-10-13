import { test, expect } from '@playwright/test';

test('residence is saved independently of remote starts and survives reload', async ({ page }) => {
  const stamp = new Date().toISOString();
  let daemon = {
    host_id: 1, enabled: false, resident_enabled: false, username: 'root', default_cwd: '',
    max_parallel: 8, idle_minutes: 60, question_minutes: 1440, sessions: [],
    residence: {requested:false,runtime_enabled:false},
    health: {state:'disabled',reasons:[],heartbeat_at:null,evaluated_at:stamp,used_slots:0,max_slots:8},
  };
  let saved: Record<string, unknown> | undefined;
  await page.route('**/admin/**', route => {
    if (!route.request().headers().accept?.includes('application/json')) return route.continue();
    const path = new URL(route.request().url()).pathname;
    const json = (data: unknown) => route.fulfill({json:{status:'ok',data}});
    if (path === '/admin/auth/status') return json({authenticated:true,enforced:true,user:{id:1,username:'owner',roles:['owner']},capabilities:['admin.read','hosts.read','settings.read','agent_messaging.manage']});
    if (path === '/admin/setup/status') return json({setup_complete:true,critical_complete:true,checks:[],next_actions:[],wizard:{completed_at:stamp,dismissed_at:null}});
    if (path === '/admin/ws/info') return json({enabled:false});
    if (path === '/admin/hosts/1/detail') return json({host:{id:1,fqdn:'resident.test',secure:true,status:'active',engines:'codex',engines_list:['codex'],updated_at:stamp,users:[]}});
    if (path === '/admin/hosts/1/daemon') {
      if (route.request().method() === 'PUT') {
        saved = route.request().postDataJSON();
        daemon = {...daemon,...saved,residence:{requested:Boolean(saved?.resident_enabled),runtime_enabled:false}};
      }
      return json(daemon);
    }
    if (path === '/admin/host-daemons') return json({hosts:[daemon]});
    if (path === '/admin/engines/state') return json({engines:['codex','claude','grok'].map(engine=>({engine,enabled:true}))});
    if (path === '/admin/insecure-approvals/pending') return json({requests:[]});
    if (path === '/admin/communicators') return json({enabled:false,connections:[]});
    return json({});
  });
  await page.goto('/admin/hosts/1?tab=operations');
  const residence = page.getByRole('switch',{name:'Keep communicator running'});
  const execution = page.getByRole('switch',{name:'Enable remote starts'});
  await expect(residence).not.toBeChecked();
  await expect(execution).not.toBeChecked();
  await residence.click();
  await expect(execution).not.toBeChecked();
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await expect.poll(()=>saved?.resident_enabled).toBe(true);
  expect(saved?.enabled).toBe(false);
  await expect(page.getByText('Residence requested; waiting for resident service support.')).toBeVisible();
  await page.reload();
  await expect(residence).toBeChecked();
  await expect(execution).not.toBeChecked();
});
