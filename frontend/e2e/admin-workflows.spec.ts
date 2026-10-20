import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installFixtures } from "./admin-fixtures";
import { definition, document, run, RUN_ID, WORKFLOW_ID, ROOM_ID, AGENT_ID, workflowFixture } from "./workflow-fixtures";

async function fixtures(page: Page) {
  const current = structuredClone(definition), report = structuredClone(run);
  const state = { enabled: true, denied: false, fail: false, empty: false, conflict: false, dropPrepare: false, dropConfirm: false, prepared: false, calls: [] as { path: string; body: Record<string,unknown> }[], errors: [] as string[], sockets: [] as WebSocketRoute[] };
  const receipts = new Map<string, unknown>();
  page.on("pageerror",e=>state.errors.push(e.message));
  await installFixtures(page);
  await page.routeWebSocket("**/workflow-ws",socket=>state.sockets.push(socket));
  await page.route(/\/admin\/workflow-(?:definitions|runs)(?:\/|\?|$)/, async route => {
    if (!route.request().headers().accept?.includes("application/json")) return route.fallback();
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    const json=(data: unknown,status=200)=>route.fulfill({status,json:data});
    let body:Record<string,unknown>={};try{body=req.postDataJSON();}catch{}
    if (req.method()==="POST") state.calls.push({path,body});
    if (state.denied) return json({status:"error",message:"Requires workflows.read"},403);
    if (state.fail && req.method()==="GET") return json({status:"error",message:"Workflow storage unavailable"},503);
    if (path.endsWith("/state")) {if(req.method()==="POST") state.enabled=Boolean(body.enabled);return json({enabled:state.enabled});}
    if (path==="/admin/workflow-definitions") {if(req.method()==="POST")return json({...current,...body,version:1});return json({enabled:state.enabled,items:state.empty||url.searchParams.get("search")==="absent"?[]:[{...current,title:current.document.title,summary:current.document.summary}],next_cursor:null});}
    if (path.endsWith("/revise")) {if(state.conflict)return json({status:"error",code:"workflow_version_conflict",message:"Head changed to version 3"},409);Object.assign(current,{...body,version:current.version+1});return json(current);}
    if (path==="/admin/workflow-runs") {
      if(req.method()==="POST") {state.prepared=true;report.status="pending";report.coordinator=null;report.members=[];report.evaluation=null;report.outcome=null;report.inputs=body.inputs as Record<string,unknown>;report.title=String(body.title);report.summary="";report.results={};report.criteria=[];report.started_at=null;report.finished_at=null;report.preparation={phase:"clarifying",revision:1,notes:"",questions:[],summary:null,confirmation:null};report.tasks=report.tasks.map(t=>({...t,status:"pending",attempt_no:0}));if(state.dropPrepare){state.dropPrepare=false;return route.abort("failed");}return json(report);}
      return json({enabled:state.enabled,items:[report],next_cursor:null});
    }
    if(path.endsWith("/control")){
      const receipt=receipts.get(String(body.client_request_id));if(receipt)return json(receipt);
      if(report.preparation){
        if(body.expected_run_version!==report.version)return json({status:"error",code:"workflow_run_version_conflict",message:"Run revision changed"},409);
        const p=report.preparation;
        if(body.action==="configure"){report.inputs=(body.inputs as Record<string,unknown>)??report.inputs;report.title=String(body.title??report.title);p.questions=(body.questions as typeof p.questions)??p.questions;p.revision++;p.phase="clarifying";p.summary=null;p.confirmation=null;}
        if(body.action==="present_summary"){p.revision++;p.notes=String(body.notes??"");p.summary={revision:p.revision,title:report.title,goal:document.goal.statement,inputs:structuredClone(report.inputs),questions:structuredClone(p.questions),tasks:structuredClone(document.tasks),notes:p.notes};p.phase="awaiting_confirmation";p.confirmation=null;}
        if(body.action==="confirm_summary"){p.phase="ready";p.confirmation={summary_revision:Number(body.summary_revision),actor:{kind:"admin",id:"1"},time:report.updated_at,channel:"web",user_confirmation:"Confirmed in the workflow review"};}
        report.version++;const result=structuredClone(report);receipts.set(String(body.client_request_id),result);
        if(state.dropConfirm&&body.action==="confirm_summary"){state.dropConfirm=false;return route.abort("failed");}return json(result);
      }
      Object.assign(report,{version:report.version+1,status:body.action==="pause"?"paused":body.action==="resume"?"running":report.status});return json(report);}
    if(path.startsWith("/admin/workflow-runs/")&&!path.endsWith("/events")&&!path.includes("/tasks/"))return json({...report,enabled:state.enabled,next_cursor:null});
    const data=workflowFixture(path);
    if(path.startsWith("/admin/workflow-definitions/")&&!path.endsWith("/versions")&&!path.includes("/versions/"))return json({...current,enabled:state.enabled});
    return json(data ?? {});
  });
  return {state,current,report};
}

test("catalog distinguishes disabled, empty, filtered, denied and failed states",async({page})=>{
  const {state}=await fixtures(page);await page.goto("/admin/workflows");
  await expect(page.getByRole("link",{name:document.title,exact:true})).toBeVisible();
  await page.getByLabel("Find workflows").fill("absent");await page.getByRole("button",{name:"Search",exact:true}).click();await expect(page.getByText("No matches",{exact:true})).toBeVisible();await expect(page).toHaveURL(/search=absent/);await page.getByRole("button",{name:"Clear filters"}).click();
  await page.getByRole("switch",{name:"Workflows enabled"}).click();await expect(page.getByText("Workflows are disabled",{exact:true})).toBeVisible();await expect(page.getByRole("link",{name:"New workflow",exact:true})).toBeVisible();
  state.empty=true;await page.reload();await expect(page.getByText("No workflows created",{exact:true})).toBeVisible();
  state.fail=true;await page.reload();await expect(page.getByRole("alert").first()).toContainText(/Could not load|unavailable/);await expect(page.getByText("No workflows created",{exact:true})).toHaveCount(0);
  state.fail=false;state.denied=true;await page.reload();await expect(page.getByRole("alert").last()).toContainText("Requires workflows.read");expect(state.errors).toEqual([]);
});

test("structured editor preserves draft on rejection and compares the current head",async({page})=>{
  const {state,current}=await fixtures(page);await page.goto("/admin/workflows/definitions/verify-artifacts?mode=edit");
  await expect(page.getByRole("textbox",{name:"Goal",exact:true})).toHaveAttribute("readonly","");
  await page.getByRole("textbox",{name:"Title",exact:true}).fill("Retained release draft");await page.getByLabel("Change reason").fill("Clarify artifact checks");state.conflict=true;current.version=3;
  await page.getByRole("button",{name:"Publish new version"}).click();await expect(page.getByRole("alert")).toContainText("Head changed");await expect(page.getByRole("textbox",{name:"Title",exact:true})).toHaveValue("Retained release draft");
  await page.getByRole("button",{name:"Load current head for comparison"}).click();await expect(page.getByText("Current head: version 3.",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:"I reviewed the comparison",exact:false}).click();state.conflict=false;await page.getByRole("button",{name:"Publish new version"}).click();await expect(page.getByText("Saved. Confirmed by the server.",{exact:true})).toBeVisible();
  expect(state.calls.filter(c=>c.path.endsWith("/revise")).map(c=>c.body.expected_workflow_version)).toEqual([2,3]);expect(state.errors).toEqual([]);
});

test("new workflow validates tasks and offers keyboard dependency ordering",async({page})=>{
  const {state}=await fixtures(page);await page.goto("/admin/workflows/new");await page.getByRole("button",{name:"Create workflow",exact:true}).click();await expect(page.getByRole("alert").first()).toContainText("Correct these fields");
  await page.getByRole("textbox",{name:"Title",exact:true}).fill("Artifact checks");await page.getByRole("textbox",{name:"Slug",exact:true}).fill("artifact-checks");await page.getByRole("textbox",{name:"Goal",exact:true}).fill("Verify artifacts");await page.getByRole("textbox",{name:"Success criterion 1",exact:true}).fill("Both hashes match");await page.getByRole("textbox",{name:"Task 1 title",exact:true}).fill("Create files");await page.getByRole("textbox",{name:"Task 1 instructions",exact:true}).fill("Create and hash two files");await page.getByLabel("Task 1 acceptance criteria, one per line").fill("Both files exist");
  await page.getByRole("button",{name:"Add task",exact:true}).click();await expect(page.getByRole("group",{name:"Dependencies for task 2"}).getByRole("checkbox")).toBeChecked();
  await page.getByRole("button",{name:"Move task 2 up"}).focus();await page.keyboard.press("Enter");await expect(page.getByRole("textbox",{name:"Task 2 title",exact:true})).toHaveValue("Create files");
  await page.getByRole("textbox",{name:"Task 1 title",exact:true}).fill("Verify files");await page.getByRole("textbox",{name:"Task 1 instructions",exact:true}).fill("Read both hashes");await page.getByLabel("Task 1 acceptance criteria, one per line").fill("Hashes match");await page.getByLabel("Change reason").fill("Initial instruction");await page.getByRole("button",{name:"Create workflow",exact:true}).click();await expect(page).toHaveURL(/definitions\/artifact-checks/);expect(state.calls[0].body.document).toMatchObject({schema_version:1,knowledge:[]});expect(state.errors).toEqual([]);
});

test("typed preparation retries a lost response with the same receipt and no agent start",async({page})=>{
  const {state}=await fixtures(page);await page.goto("/admin/workflows/definitions/verify-artifacts?mode=run");await page.getByRole("textbox",{name:"Release name",exact:true}).fill("release-42");await page.getByRole("spinbutton",{name:"Copies",exact:true}).fill("3");await page.getByLabel("Dry run",{exact:true}).selectOption("false");await page.getByLabel("Region",{exact:true}).selectOption("east");state.dropPrepare=true;
  await page.getByRole("button",{name:"Prepare run",exact:true}).click();await expect(page.getByRole("alert")).toContainText("Save not confirmed");await expect(page.getByRole("textbox",{name:"Release name",exact:true})).toHaveValue("release-42");await page.getByRole("button",{name:"Prepare run",exact:true}).click();await expect(page).toHaveURL(new RegExp(RUN_ID));await expect(page.getByText("Prepared; no agent has started execution.")).toBeVisible();await expect(page.getByRole("button",{name:"Copy assignment"})).toBeVisible();
  const calls=state.calls.filter(c=>c.path==="/admin/workflow-runs");expect(calls).toHaveLength(2);expect(calls[0].body).toEqual(calls[1].body);expect(calls[1].body).toMatchObject({version:2,workflow_id:WORKFLOW_ID,inputs:{release:"release-42",copies:3,dry_run:false,region:"east"}});expect(state.errors).toEqual([]);
});

test("live report shows results before evidence and keeps evaluation distinct from completion",async({page})=>{
  const {state}=await fixtures(page);await page.goto(`/admin/workflows/runs/${RUN_ID}`);await expect(page.getByRole("heading",{name:"Release 42 verification",exact:true})).toBeVisible();await expect(page.getByText("Evaluation pending",{exact:true})).toBeVisible();await expect(page.getByRole("definition").filter({hasText:"release-42.tar"})).toBeVisible();
  const resultTop=await page.getByRole("heading",{name:"Result",exact:true}).evaluate(el=>el.getBoundingClientRect().top),taskTop=await page.getByRole("heading",{name:"Tasks",exact:true}).evaluate(el=>el.getBoundingClientRect().top);expect(resultTop).toBeLessThan(taskTop);
  await page.getByText("Produce artifacts",{exact:true}).click();await expect(page.getByText("build01.example.test",{exact:false}).first()).toBeVisible();await expect(page.getByText("Artifact hashes",{exact:true})).toBeVisible();await expect(page.getByRole("link",{name:"Open evidence",exact:true})).toHaveAttribute("href","https://example.test/hash");await expect(page.getByRole("link",{name:"Open run group"})).toHaveAttribute("href",`/admin/agents?view=live&room=${ROOM_ID}`);
  await page.reload();await expect(page.getByText("Evaluation pending",{exact:true})).toBeVisible();expect(state.errors).toEqual([]);
});

test("final report exposes applied version and sanitizes untrusted Markdown and links",async({page})=>{
  const {report,state}=await fixtures(page);report.status="completed";report.completed_at=report.finished_at;report.evaluation={version:2,status:"final",applied_version:2,draft:{decision:"revise",reason:"Clarified verification.",findings:[{text:"Hash instructions were unclear"}],lessons:["Record digests before handoff."]}};report.summary='# Done\n\n<script>window.workflowXss=1</script><img src=x onerror="window.workflowXss=1">[Unsafe](javascript:alert(1))';report.results={safe:"https://example.test/proof",unsafe:"javascript:alert(1)"};
  await page.goto(`/admin/workflows/runs/${RUN_ID}`);await expect(page.getByRole("heading",{name:"Workflow improved",exact:true})).toBeVisible();await expect(page.getByRole("link",{name:"Published version 2"})).toBeVisible();await expect(page.getByRole("region",{name:"Changes to tasks"})).toContainText("Compare hashes");await expect(page.locator("h1")).toHaveCount(1);expect(await page.evaluate(()=>Object.hasOwn(window,"workflowXss"))).toBe(false);expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);await expect(page.getByRole("link",{name:"Read group history"})).toBeVisible();expect(state.errors).toEqual([]);
});

for(const width of [320,390,768,1440,1920])for(const theme of ["light","dark"] as const)test(`report reflows ${theme} ${width} with accessible status and focus`,async({page},info)=>{
  await page.setViewportSize({width,height:width===768?1024:900});await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});await page.addInitScript(theme=>localStorage.setItem("codex.theme",theme),theme);const {report,state}=await fixtures(page);report.tasks[0].status="uncertain";report.tasks[0].claim={owner_address_id:AGENT_ID,generation:2,lease_until:"2026-01-01T00:00:00Z",recovery:false};report.title+=" — "+"Readable long title ".repeat(6);await page.goto(`/admin/workflows/runs/${RUN_ID}`);await expect(page.getByText("Uncertain attempts require reconciliation",{exact:false})).toBeVisible();expect(await page.locator("main").evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(2);await page.getByRole("button",{name:"Copy link",exact:true}).focus();await expect(page.getByRole("button",{name:"Copy link",exact:true})).toBeFocused();
  if(width===320||width===1440){await page.screenshot({path:info.outputPath(`report-${theme}-${width}.png`),fullPage:true});const axe=await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa"]).analyze();expect(axe.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);}expect(state.errors).toEqual([]);
});

test("WS changes refresh the report and retain stale evidence",async({page})=>{
  const {state,report}=await fixtures(page);await page.route("**/admin/ws/info",route=>route.fulfill({json:{enabled:true,url:new URL("/workflow-ws",route.request().url()).href.replace(/^http/,"ws"),heartbeat_seconds:60}}));
  await page.goto(`/admin/workflows/runs/${RUN_ID}`);await expect.poll(()=>state.sockets.length).toBeGreaterThan(0);report.summary="Updated structured result";state.sockets.at(-1)!.send(JSON.stringify({type:"workflow.run.changed",payload:{run_id:RUN_ID}}));await expect(page.getByText("Updated structured result",{exact:true})).toBeVisible();state.fail=true;state.sockets.at(-1)!.send(JSON.stringify({type:"workflow.run.changed",payload:{run_id:RUN_ID}}));await expect(page.getByText("Refresh failed. Showing the previously loaded report",{exact:false})).toBeVisible({timeout:15000});await expect(page.getByText("Updated structured result",{exact:true})).toBeVisible();
});


test("workflow refresh preserves unsaved editor values and keyboard focus", async ({page}) => {
  const {state,current}=await fixtures(page);
  await page.route("**/admin/ws/info",route=>route.fulfill({json:{enabled:true,url:new URL("/workflow-ws",route.request().url()).href.replace(/^http/,"ws"),heartbeat_seconds:60}}));
  await page.goto("/admin/workflows/definitions/verify-artifacts?mode=edit");
  const title=page.getByRole("textbox",{name:"Title",exact:true});await title.fill("Unsaved operator draft");await title.focus();
  await expect.poll(()=>state.sockets.length).toBeGreaterThan(0);current.document.title="A newly published server title";current.version=3;
  state.sockets.at(-1)!.send(JSON.stringify({type:"workflow.changed",payload:{workflow_id:WORKFLOW_ID}}));
  await expect(page.getByRole("heading",{name:"A newly published server title",exact:true})).toBeVisible();await expect(title).toHaveValue("Unsaved operator draft");await expect(title).toBeFocused();
  page.once("dialog",dialog=>dialog.dismiss());await page.getByRole("link",{name:"Back to workflows",exact:true}).click();await expect(title).toHaveValue("Unsaved operator draft");expect(state.errors).toEqual([]);
});


test("run filters survive report navigation and back",async({page})=>{
  await fixtures(page);await page.goto("/admin/workflows/runs?status=evaluating&evaluation=pending");
  await expect(page.getByLabel("Run status")).toHaveValue("evaluating");await page.getByRole("link",{name:"Release 42 verification",exact:true}).click();await expect(page).toHaveURL(new RegExp(RUN_ID));await page.goBack();await expect(page.getByLabel("Run status")).toHaveValue("evaluating");await expect(page.getByLabel("Run evaluation")).toHaveValue("pending");
});

test("permission gates prevent editing and keep run chat reveal separate",async({page})=>{
  const {state}=await fixtures(page);await page.route("**/admin/auth/status",route=>route.fulfill({json:{authenticated:true,enforced:true,user:{id:1,username:"reader",roles:["viewer"]},capabilities:["admin.read","workflows.read"]}}));
  await page.goto(`/admin/workflows/runs/${RUN_ID}`);await expect(page.getByText("Group content requires agent_messaging.reveal_content",{exact:false})).toBeVisible();await expect(page.getByRole("link",{name:"Open run group"})).toHaveCount(0);await expect(page.getByRole("heading",{name:"Run controls",exact:true})).toHaveCount(0);
  await page.goto("/admin/workflows/definitions/verify-artifacts?mode=edit");await expect(page.getByRole("textbox",{name:"Title",exact:true})).toBeDisabled();await expect(page.getByText("Your account can read this workflow.",{exact:false})).toBeVisible();expect(state.calls).toHaveLength(0);
});

test("run controls describe external process limits and retain reasons on CAS conflict",async({page})=>{
  const {state,report}=await fixtures(page);report.status="running";report.outcome=null;await page.goto(`/admin/workflows/runs/${RUN_ID}`);await expect(page.getByText("Pause and cancellation stop new claims.",{exact:false})).toBeVisible();await page.getByLabel("Reason for control or recovery").fill("Inspect old process first");let conflict=true;await page.route(`**/admin/workflow-runs/${RUN_ID}/control`,route=>{if(conflict){conflict=false;return route.fulfill({status:409,json:{status:"error",code:"workflow_run_version_conflict",message:"Run revision changed"}});}return route.fallback();});await page.getByRole("button",{name:"Pause new work"}).click();await expect(page.getByRole("alert")).toContainText("Run revision changed");await expect(page.getByLabel("Reason for control or recovery")).toHaveValue("Inspect old process first");await page.getByRole("button",{name:"Reload current run state"}).click();await page.getByRole("button",{name:"Pause new work"}).click();await expect(page.getByRole("button",{name:"Resume run"})).toBeVisible();expect(state.calls.find(c=>c.path.endsWith("/control"))?.body).toMatchObject({action:"pause",expected_run_version:4,reason:"Inspect old process first"});
});


test("coarse-pointer report actions and enlarged text retain access",async({browser})=>{
  const context=await browser.newContext({hasTouch:true,viewport:{width:390,height:844}});const page=await context.newPage();await fixtures(page);await page.goto(`/admin/workflows/runs/${RUN_ID}`);
  const copy=page.getByRole("button",{name:"Copy link",exact:true});const bounds=await copy.boundingBox();expect(bounds?.height).toBeGreaterThanOrEqual(44);expect(bounds?.width).toBeGreaterThanOrEqual(44);
  await page.addStyleTag({content:"html{font-size:200% !important}"});expect(await page.locator("main").evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(2);await expect(copy).toBeVisible();await context.close();
});


test("execution prerequisite failures remain distinct from an empty catalog or a prepared run",async({page})=>{
  await fixtures(page);const unavailable_reason="Agent Messaging is disabled. Definitions and prepared runs remain manageable; enable Agent Messaging for agent execution and invitations.";
  await page.route("**/admin/workflow-definitions/state",route=>route.fulfill({json:{enabled:true,messaging_enabled:false,unavailable_reason}}));
  await page.goto(`/admin/workflows/runs/${RUN_ID}`);await expect(page.getByText(unavailable_reason,{exact:true})).toBeVisible();await expect(page.getByRole("link",{name:"Agent Messaging settings",exact:true})).toHaveAttribute("href","/admin/agent-messaging");await expect(page.getByRole("heading",{name:"Release 42 verification",exact:true})).toBeVisible();
});

test("claim expiry uses the observed server clock despite workstation skew",async({page})=>{
  await page.clock.install({time:new Date("2039-01-01T00:00:00Z")});const {report}=await fixtures(page);report.status="running";report.outcome=null;report.tasks[0].status="running";report.tasks[0].claim={owner_address_id:AGENT_ID,generation:1,lease_until:"2026-10-20T10:30:00Z",recovery:false};
  await page.goto(`/admin/workflows/runs/${RUN_ID}`);await expect(page.getByRole("heading",{name:"Release 42 verification",exact:true})).toBeVisible();await expect(page.getByText("Uncertain attempts require reconciliation",{exact:false})).toHaveCount(0);
  await page.clock.fastForward(31*60*1000);await expect(page.getByText("Uncertain attempts require reconciliation",{exact:false})).toBeVisible();
});


test("clarification saves incomplete answers, reviews explicit approval, retries and invalidates corrected summaries", async ({page}) => {
  const {state,report}=await fixtures(page);
  await page.goto("/admin/workflows/definitions/verify-artifacts?mode=run");
  await page.getByRole("button",{name:"Prepare run",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Prepare execution",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Review execution summary",exact:true}).click();
  await expect(page.locator("#workflow-preparation-errors")).toBeFocused();
  await expect(page.locator("#run-input-release")).toHaveAttribute("aria-invalid","true");
  await page.getByRole("textbox",{name:"Release name",exact:true}).fill("release-42");
  await page.getByRole("button",{name:"Add follow-up question",exact:true}).click();
  await page.getByRole("textbox",{name:"Additional question 1",exact:true}).fill("Which operating system?");
  await page.getByRole("textbox",{name:"Answer 1",exact:true}).fill("Debian");
  await expect(page.getByRole("button",{name:"Review execution summary",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Save answers",exact:true}).click();
  await expect(page.getByRole("button",{name:"Review execution summary",exact:true})).toBeEnabled();
  await page.getByRole("textbox",{name:"Additional agreements (optional)",exact:true}).fill("Use existing network");
  await page.getByRole("button",{name:"Review execution summary",exact:true}).click();
  await expect(page.locator("#execution-summary-heading")).toBeFocused();
  await expect(page.getByRole("definition").filter({hasText:"Debian"})).toBeVisible();
  await expect(page.getByText("Use existing network",{exact:true})).toBeVisible();
  expect(report.status).toBe("pending");expect(report.preparation?.confirmation).toBeNull();
  state.dropConfirm=true;
  await page.getByRole("button",{name:"Confirm execution summary",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Save not confirmed");
  await page.getByRole("button",{name:"Confirm execution summary",exact:true}).click();
  await expect(page.getByText("Ready for an agent to start execution.",{exact:false})).toBeVisible();
  const confirms=state.calls.filter(c=>c.body.action==="confirm_summary");expect(confirms).toHaveLength(2);expect(confirms[0].body).toEqual(confirms[1].body);
  await page.getByText("Correct answers or add a question",{exact:true}).click();
  await page.getByRole("textbox",{name:"Release name",exact:true}).fill("release-43");
  await page.getByRole("button",{name:"Save answers",exact:true}).click();
  await expect(page.getByRole("button",{name:"Review execution summary",exact:true})).toBeVisible();
  await expect(page.getByRole("textbox",{name:"Additional agreements (optional)",exact:true})).toHaveValue("Use existing network");
  expect(report.preparation?.confirmation).toBeNull();
  await page.getByRole("button",{name:"Review execution summary",exact:true}).click();
  await expect(page.getByRole("definition").filter({hasText:"release-43"})).toBeVisible();
  await page.getByRole("button",{name:"Confirm execution summary",exact:true}).click();
  await page.reload();await expect(page.getByText("Ready for an agent to start execution.",{exact:false})).toBeVisible();
  expect(report.status).toBe("pending");expect(state.errors).toEqual([]);
});

for(const width of [320,1440])for(const theme of ["light","dark"] as const)test(`clarification review accessible ${theme} ${width}`,async({page},info)=>{
  const {report,state}=await fixtures(page);
  report.status="pending";report.summary="";report.coordinator=null;report.results={};
  report.preparation={phase:"awaiting_confirmation",revision:2,notes:"Review before execution",questions:[],confirmation:null,
    summary:{revision:2,title:report.title,goal:document.goal.statement,inputs:report.inputs,questions:[{id:"os",question:"Which operating system?",answer:"Debian"}],tasks:document.tasks,notes:"Review before execution"}};
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});await page.addInitScript(theme=>localStorage.setItem("codex.theme",theme),theme);
  await page.goto(`/admin/workflows/runs/${RUN_ID}`);
  const button=page.getByRole("button",{name:"Confirm execution summary",exact:true});await button.focus();await expect(button).toBeFocused();
  expect(await page.locator("main").evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(2);
  const axe=await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa"]).analyze();expect(axe.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
  await page.screenshot({path:info.outputPath(`clarification-${theme}-${width}.png`),fullPage:true});expect(state.errors).toEqual([]);
});


test("concurrent answer changes retain the local draft and require comparison before retry",async({page})=>{
  const {report,state}=await fixtures(page);report.status="pending";report.summary="";report.inputs={release:"original",copies:2,dry_run:false};
  report.preparation={phase:"clarifying",revision:1,notes:"",questions:[],summary:null,confirmation:null};
  await page.goto(`/admin/workflows/runs/${RUN_ID}`);
  const answer=page.getByRole("textbox",{name:"Release name",exact:true});await answer.fill("local draft");
  report.inputs.release="another operator's answer";report.version++;
  await page.getByRole("button",{name:"Save answers",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Run revision changed");await expect(answer).toHaveValue("local draft");
  await page.getByRole("button",{name:"Load current answers for comparison",exact:true}).click();
  await expect(page.getByRole("definition").filter({hasText:"another operator's answer"})).toBeVisible();await expect(answer).toHaveValue("local draft");
  await page.getByRole("button",{name:"I reviewed the saved answers; keep my draft",exact:true}).click();
  await page.getByRole("button",{name:"Save answers",exact:true}).click();
  await expect(page.getByText("Saved. Confirmed by the server.",{exact:true})).toBeVisible();
  expect(report.inputs.release).toBe("local draft");expect(state.calls.filter(c=>c.body.action==="configure").map(c=>c.body.expected_run_version)).toEqual([4,5]);expect(state.errors).toEqual([]);
});

test("required source checks retain the applicability draft and publish an explicit opt-in", async ({ page }, testInfo) => {
  const { state } = await fixtures(page);
  await page.goto("/admin/workflows/definitions/verify-artifacts?mode=edit");
  await page.getByRole("button", { name: "Add knowledge", exact: true }).click();
  await page.getByLabel("Source 1 title").fill("Linux runbook");
  await page.getByLabel("Notes (Markdown)").fill("Read the Linux task instructions.");
  const optIn = page.getByRole("checkbox", { name: "Require an applicable source receipt before linked tasks start" });
  await optIn.focus(); await page.keyboard.press("Space");
  await page.getByLabel("Change reason").fill("Require source applicability checks");
  await page.getByRole("button", { name: "Publish new version", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText("Describe the scope and operating system");
  await page.getByRole("textbox", { name: "Required scope and operating system" }).fill("Linux hosts only");
  await page.getByRole("group", { name: "Knowledge for task 1", exact: true }).getByRole("checkbox", { name: "Linux runbook" }).check();
  await page.screenshot({ path: testInfo.outputPath("source-check-editor.png"), fullPage: true });
  await page.getByRole("button", { name: "Publish new version", exact: true }).click();
  await expect(page.getByText("Saved. Confirmed by the server.", { exact: true })).toBeVisible();
  const saved = state.calls.find(c => c.path.endsWith("/revise"))!.body.document as typeof document;
  expect(saved.knowledge[0]).toMatchObject({ required_check: { applicability: "Linux hosts only" } });
  expect(saved.tasks[0].knowledge_ids).toEqual([saved.knowledge[0].id]);
  expect(state.errors).toEqual([]);
});

for (const theme of ["light", "dark"] as const) for (const width of [320, 390, 1440]) {
  test(`source receipt blockers and attribution remain readable at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    const { report, state } = await fixtures(page);
    report.document!.knowledge = [{ id: "linux", title: "Linux runbook", reference: { uri: "shared://linux-runbook" }, required_check: { applicability: "Linux production hosts only" } }];
    report.document!.tasks[0].knowledge_ids = ["linux"];
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/admin/theme", route => route.fulfill({ json: { theme } }));
    await page.route(`**/admin/workflow-runs/${RUN_ID}/tasks/produce*`, route => route.fulfill({ json: {
      task: report.tasks[0], attempts: [], next_cursor: null,
      knowledge: { subject: { name: "Artifact reviewer", address_id: AGENT_ID, binding_generation: 2 }, role: "coordinator", checks: [
        { knowledge_id: "linux", title: "Linux runbook", uri: `shared://linux-runbook/${"long-scope-".repeat(20)}`, applicability: "Linux production hosts only", blocker: "applicability_mismatch", receipt: { event_id: "receipt", actor: { name: "Artifact reviewer" }, recorded_at: report.updated_at, source: { read_at: report.updated_at, digest: "a".repeat(64), applicability_reason: "The target is Windows; use a matching runbook before claiming this task." } } },
        { knowledge_id: "missing", title: "Unread source", uri: "shared://unread", applicability: "Current host", blocker: "missing_receipt", receipt: null },
      ] },
    } }));
    await page.goto(`/admin/workflows/runs/${RUN_ID}`);
    await expect(page.getByText("Source receipt required before claim", { exact: true })).toBeVisible();
    await page.getByText("Produce artifacts", { exact: true }).click();
    const checks = page.getByRole("region", { name: "Required source checks" });
    await expect(checks).toContainText("Agent attestations for the coordinator: Artifact reviewer · Binding 2");
    await expect(checks).toContainText("Applicability mismatch");
    await expect(checks).toContainText("Missing receipt");
    await expect(checks).toContainText("Each agent needs its own receipts");
    expect(await page.locator("main").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
    const axe = await new AxeBuilder({ page }).include('[aria-label="Required source checks"]').analyze();
    expect(axe.violations).toEqual([]);
    await checks.screenshot({ path: testInfo.outputPath("source-checks.png") });
    expect(state.errors).toEqual([]);
  });
}
