import assert from "node:assert/strict";
import { it } from "node:test";

const modulePath: string = "./model-tier-board.ts";
const { defaultsDraft, deviations, draftFrom, tierColumns, tierKey, tierPayload, unsavedMoves } = await import(modulePath) as typeof import("./model-tier-board");

const models = [
  { engine: "codex" as const, id: "gpt-6.2-sol", tier: 3, default_tier: 3 },
  { engine: "claude" as const, id: "claude-sonnet-5-5", tier: 4, default_tier: 3 },
  { engine: "grok" as const, id: "grok-4.7", tier: 2, default_tier: 2 },
];
const levels = [1, 2, 3, 4, 5].map((tier) => ({ tier, work: `work ${tier}` }));

it("counts unsaved moves against the saved tiers and deviations against the registry", () => {
  const draft = draftFrom(models);
  assert.equal(unsavedMoves(models, draft), 0);
  assert.equal(deviations(models, draft), 1);
  draft[tierKey(models[0]!)] = 5;
  assert.equal(unsavedMoves(models, draft), 1);
  assert.equal(deviations(models, draft), 2);
  assert.equal(deviations(models, defaultsDraft(models)), 0);
  assert.equal(unsavedMoves(models, defaultsDraft(models)), 1);
});

it("sends every model, hidden engines included, so a save never drops a placement", () => {
  const draft = { ...draftFrom(models), [tierKey(models[0]!)]: 5 };
  assert.deepEqual(tierPayload(models, draft), {
    codex: { "gpt-6.2-sol": 5 },
    claude: { "claude-sonnet-5-5": 4 },
    grok: { "grok-4.7": 2 },
  });
});

it("fills each column with the visible models of its tier in canonical order", () => {
  const columns = tierColumns(levels, models, draftFrom(models), (engine) => engine !== "grok");
  assert.deepEqual(columns.map((column) => [column.tier, column.models.map((model) => model.id)]), [
    [1, []], [2, []], [3, ["gpt-6.2-sol"]], [4, ["claude-sonnet-5-5"]], [5, []],
  ]);
});
