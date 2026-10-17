import assert from "node:assert/strict";
import { describe, it } from "node:test";

const mod: string = "./engine-tabs.ts";
const { resolveEngineHash, engineHash } = (await import(mod)) as typeof import("./engine-tabs");

describe("engine page hashes", () => {
  it("keeps every pre-tab anchor id pointing at its content", () => {
    assert.deepEqual(resolveEngineHash("#engine-state"), { tab: "fleet", sub: null });
    assert.deepEqual(resolveEngineHash("#quota-enforcement"), { tab: "fleet", sub: null });
    assert.deepEqual(resolveEngineHash("#codex-defaults"), { tab: "codex", sub: "models" });
    assert.deepEqual(resolveEngineHash("#claude-client"), { tab: "claude", sub: "client" });
  });
  it("addresses the model-defaults tab that replaced the Quick Settings page", () => {
    assert.deepEqual(resolveEngineHash("#defaults"), { tab: "defaults", sub: null });
    assert.equal(engineHash("defaults", null), "#defaults");
  });
  it("round-trips tab and sub-tab, and rejects unknowns", () => {
    assert.deepEqual(resolveEngineHash(engineHash("grok", "versions")), { tab: "grok", sub: "versions" });
    assert.deepEqual(resolveEngineHash("#claude/bogus"), { tab: "claude", sub: null });
    assert.equal(resolveEngineHash("#nope"), null);
    assert.equal(resolveEngineHash(""), null);
  });
});
