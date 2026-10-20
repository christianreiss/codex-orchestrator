import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({resolve(specifier,context,next){return next(specifier === "./client" ? "./client.ts" : specifier,context);}});
const modulePath: string = "./workflows.ts";
const {workflowsApi} = await import(modulePath) as typeof import("./workflows");
describe("workflow API contract", () => {
  it("keeps browser paths separate and preserves mutation receipt/CAS values", async () => { const old=globalThis.fetch, calls:{url:string;body:unknown}[]=[]; globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):null});return new Response(JSON.stringify({status:"ok",data:{enabled:true}}),{headers:{"content-type":"application/json"}});}; try { await workflowsApi.runList({status:"evaluating",agent_address_id:"a",cursor:50}); await workflowsApi.archive("id",{client_request_id:"receipt",expected_workflow_version:2,expected_control_version:4,reason:"History"}); await workflowsApi.control("run",{client_request_id:"receipt2",expected_run_version:9,action:"pause",reason:"Check target"}); assert.equal(calls[0].url,"/admin/workflow-runs?status=evaluating&agent_address_id=a&cursor=50"); assert.deepEqual(calls[1].body,{client_request_id:"receipt",expected_workflow_version:2,expected_control_version:4,reason:"History"}); assert.equal(calls[2].url,"/admin/workflow-runs/run/control"); } finally {globalThis.fetch=old;} });
});
