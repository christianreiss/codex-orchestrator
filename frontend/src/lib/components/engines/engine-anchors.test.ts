import assert from "node:assert/strict";
import { describe, it } from "node:test";

const mod: string = "./engine-anchors.ts";
const { advancedEngineForHash, tabEngineForHash, movedAnchorTarget } = (await import(mod)) as typeof import("./engine-anchors");

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

describe("tabEngineForHash", () => {
  it("selects the engine tab for defaults and Advanced anchors", () => {
    assert.equal(tabEngineForHash("#codex-defaults"), "codex");
    assert.equal(tabEngineForHash("grok-defaults"), "grok");
    assert.equal(tabEngineForHash("#claude-danger"), "claude");
    assert.equal(tabEngineForHash("#claude-client"), "claude");
    assert.equal(tabEngineForHash("#codex-native-settings"), "codex");
  });
  it("keeps the current tab for page-level and unknown anchors", () => {
    for (const hash of ["#engine-state", "#defaults", "#nope", ""]) assert.equal(tabEngineForHash(hash), null, hash);
  });
});

describe("movedAnchorTarget", () => {
  it("points moved sections at their new page", () => {
    assert.equal(movedAnchorTarget("#quota-enforcement"), "/limits#quota-enforcement");
    assert.equal(movedAnchorTarget("#scaling-rules"), "/limits#scaling-rules");
    assert.equal(movedAnchorTarget("cxx-rollout"), "/settings#cxx-rollout");
    assert.equal(movedAnchorTarget("#chatty"), "/settings#chatty");
  });
  it("ignores anchors that still live on /engines", () => {
    for (const hash of ["#engine-state", "#codex-defaults", "#codex-danger", ""]) assert.equal(movedAnchorTarget(hash), null, hash);
  });
});
