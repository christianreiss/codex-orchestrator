import assert from "node:assert/strict";
import { describe, it } from "node:test";

const routesModule: string = "./legacy-admin-routes.ts";
const { legacyAuthoringTarget, settingsLegacyTarget } = (await import(routesModule)) as typeof import("./legacy-admin-routes");

describe("legacy admin destinations", () => {
  it("maps retired Settings tabs and section hashes to their single owner", () => {
    assert.equal(settingsLegacyTarget(new URLSearchParams()), "/api-keys#service-availability");
    assert.equal(settingsLegacyTarget(new URLSearchParams("tab=engines")), "/engines");
    assert.equal(settingsLegacyTarget(new URLSearchParams("tab=fleet-policy")), "/policies");
    assert.equal(settingsLegacyTarget(new URLSearchParams("tab=claude-config")), "/engines#claude-client");
    assert.equal(settingsLegacyTarget(new URLSearchParams(), "#log-retention"), "/policies#log-retention");
    assert.equal(settingsLegacyTarget(new URLSearchParams("tab=availability"), "#agent-messaging"), "/agent-messaging#service-state");
  });

  it("keeps old Authoring bookmarks valid while using direct knowledge routes", () => {
    assert.equal(legacyAuthoringTarget(""), "/skills");
    assert.equal(legacyAuthoringTarget("/skills/deploy"), "/skills/deploy");
    assert.equal(legacyAuthoringTarget("/agents"), "/instructions");
    assert.equal(legacyAuthoringTarget("/output-styles/brief"), "/output-styles/brief");
  });
});
