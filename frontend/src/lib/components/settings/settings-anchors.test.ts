import assert from "node:assert/strict";
import { it } from "node:test";

const modulePath: string = "./settings-anchors.ts";
const { SETTINGS_GROUPS, isSettingsGroup, settingsGroupForHash } = await import(modulePath) as typeof import("./settings-anchors");

it("maps every retired flat-page anchor to the tab that now holds it", () => {
  const cases: Record<string, string> = {
    "#hosts": "hosts", "#auto-update": "hosts", "#reverse-dns": "hosts", "#insecure-approval": "hosts", "#host-spawn": "hosts",
    "#host-lifecycle": "hosts", "#prune-policy": "hosts",
    "#agents": "agents", "#agent-sessions": "agents", "#api-keys-in-chat": "agents", "#model-tier-check": "agents",
    "#subagent-model-selection": "agents", "#authorization": "agents", "#agent-coordination": "agents", "#agent-supervisor": "agents", "#chatty": "agents",
    "#cxx-rollout": "rollout", "#rtk": "rollout",
    "#retention": "retention", "#session-housekeeping": "retention",
  };
  for (const [hash, group] of Object.entries(cases)) assert.equal(settingsGroupForHash(hash), group, hash);
});

it("keeps the current tab for unknown, empty and prototype-named hashes", () => {
  for (const hash of ["", "#", "#nope", "#constructor", "#__proto__", "#%E0%A4%A"]) {
    assert.doesNotThrow(() => settingsGroupForHash(hash));
  }
  assert.equal(settingsGroupForHash("#nope"), null);
  assert.equal(settingsGroupForHash("#constructor"), null);
});

it("recognises only the four groups", () => {
  assert.deepEqual([...SETTINGS_GROUPS], ["hosts", "agents", "rollout", "retention"]);
  assert.equal(isSettingsGroup("agents"), true);
  assert.equal(isSettingsGroup("engines"), false);
  assert.equal(isSettingsGroup(null), false);
});
