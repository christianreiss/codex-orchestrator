import { test } from "node:test";
import assert from "node:assert/strict";
const hookModule: string = "./hook-model.ts";
const { hookGroups, hooksFromGroups } = (await import(hookModule)) as typeof import("./hook-model");
const initial = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command: "first", timeout: 5 }, { type: "command" as const, command: "second", timeout: 60 }] }] };
test("editing a matcher does not normalize independent command timeouts", () => {
  const groups = hookGroups(initial); groups[0].rows[0].matcher = "Edit";
  assert.deepEqual(hooksFromGroups(groups).PreToolUse[0].hooks, initial.PreToolUse[0].hooks);
  assert.equal(initial.PreToolUse[0].matcher, "Bash");
});
test("deleting an earlier command preserves the survivor's own timeout", () => {
  const groups = hookGroups(initial); groups[0].rows[0].commands.splice(0, 1);
  assert.deepEqual(hooksFromGroups(groups).PreToolUse[0].hooks, [initial.PreToolUse[0].hooks[1]]);
});
test("editing command text keeps its timeout; a newly added command inherits none", () => {
  const groups = hookGroups(initial); groups[0].rows[0].commands[1].command = "edited";
  groups[0].rows[0].commands.push({ type: "command", command: "new" });
  assert.deepEqual(hooksFromGroups(groups).PreToolUse[0].hooks.map(command => command.timeout), [5,60,undefined]);
});
