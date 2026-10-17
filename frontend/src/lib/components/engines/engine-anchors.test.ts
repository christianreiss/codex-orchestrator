import assert from "node:assert/strict";
import { describe, it } from "node:test";

const mod: string = "./engine-anchors.ts";
const { advancedEngineForHash } = (await import(mod)) as typeof import("./engine-anchors");

describe("advancedEngineForHash", () => {
  it("opens the owning engine for anchors inside Advanced", () => {
    assert.equal(advancedEngineForHash("#claude-client"), "claude");
    assert.equal(advancedEngineForHash("#codex-native-settings"), "codex");
    assert.equal(advancedEngineForHash("grok-advanced"), "grok");
    assert.equal(advancedEngineForHash("#codex-profile-settings"), "codex");
    assert.equal(advancedEngineForHash("#cdx-silent"), "codex");
  });
  it("leaves everyday anchors alone", () => {
    for (const hash of ["#engine-state", "#defaults", "#codex-defaults", "#quota-enforcement", "#cxx-rollout", "", "#nope"]) {
      assert.equal(advancedEngineForHash(hash), null, hash);
    }
  });
});
