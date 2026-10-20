import { describe, it } from "node:test";
import assert from "node:assert/strict";
const modulePath: string = "./helpers.ts";
const {newWorkflowDocument, validateDraft, moveTask, safeWorkflowUrl} = await import(modulePath) as typeof import("./helpers");
const valid = () => { const d = newWorkflowDocument(); d.title = "Verify"; d.goal.statement = "Produce a verified artifact"; d.goal.success_criteria[0].text = "Hash matches"; d.tasks[0].title = "Build"; d.tasks[0].instructions = "Build and hash"; d.tasks[0].acceptance_criteria = ["Hash recorded"]; return d; };
describe("workflow editing", () => {
  it("accepts no knowledge and one task, while requiring one verifiable goal", () => { assert.deepEqual(validateDraft(valid()), {}); const d=valid(); d.goal.success_criteria=[]; assert.ok(validateDraft(d).criteria); d.tasks=[]; assert.ok(validateDraft(d).tasks); });
  it("detects unknown dependencies and cycles without changing draft", () => { const d=valid(); d.tasks[0].depends_on=["missing"]; assert.match(validateDraft(d).tasks,/existing/); d.tasks.push({...d.tasks[0],id:"task-2",depends_on:["task-1"]}); d.tasks[0].depends_on=["task-2"]; const before=JSON.stringify(d); assert.match(validateDraft(d).tasks,/cycle/); assert.equal(JSON.stringify(d),before); });
  it("moves tasks through buttons while preserving dependency identities", () => { const d=valid(); d.tasks.push({...d.tasks[0],id:"task-2",depends_on:["task-1"]}); const moved=moveTask(d,1,-1); assert.equal(moved.tasks[0].id,"task-2"); assert.deepEqual(moved.tasks[0].depends_on,["task-1"]); assert.equal(d.tasks[0].id,"task-1"); });
  it("allows safe report links and rejects executable, relative and token-like schemes", () => { for (const uri of ["javascript:alert(1)","data:text/html,x","file:///tmp/a","//evil.example/path","/login","shared://notes"]) assert.equal(safeWorkflowUrl(uri),null,uri); assert.equal(safeWorkflowUrl("/admin/workflows/runs/a"),"/admin/workflows/runs/a"); assert.equal(safeWorkflowUrl("https://example.test/proof"),"https://example.test/proof"); });
});
