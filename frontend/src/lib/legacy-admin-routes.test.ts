import assert from "node:assert/strict";
import { describe, it } from "node:test";

const routesModule: string = "./legacy-admin-routes.ts";
const { legacyTarget, settingsLegacyTarget } = (await import(routesModule)) as typeof import("./legacy-admin-routes");

const q = (s = "") => new URLSearchParams(s);

describe("legacy admin destinations", () => {
  it("maps retired Settings tabs and section hashes to their single owner", () => {
    assert.equal(settingsLegacyTarget(q()), null);
    assert.equal(settingsLegacyTarget(q("tab=engines")), "/engines");
    assert.equal(settingsLegacyTarget(q("tab=fleet-policy")), "/settings");
    assert.equal(settingsLegacyTarget(q("tab=claude-config")), "/engines#claude-client");
    assert.equal(settingsLegacyTarget(q("tab=availability")), "/api-keys");
    assert.equal(settingsLegacyTarget(q(), "#log-retention"), "/settings#retention");
    assert.equal(settingsLegacyTarget(q(), "#engine-state"), "/engines#engine-state");
    assert.equal(settingsLegacyTarget(q(), "#quotas"), "/limits#quota-enforcement");
    assert.equal(settingsLegacyTarget(q(), "#scaling"), "/limits#scaling-rules");
  });

  it("sends every merged page to its new home", () => {
    assert.equal(legacyTarget("/clients", q()), "/agents");
    assert.equal(legacyTarget("/topology", q()), "/agents?view=graph");
    assert.equal(legacyTarget("/logs/events", q()), "/activity?type=changes");
    assert.equal(legacyTarget("/logs/mcp", q()), "/activity?type=changes");
    assert.equal(legacyTarget("/feedback", q()), "/reports");
    assert.equal(legacyTarget("/users", q()), "/people");
    assert.equal(legacyTarget("/policies", q()), "/settings");
    assert.equal(legacyTarget("/quick-settings", q()), "/engines#defaults");
    assert.equal(legacyTarget("/settings/users", q()), "/people");
    assert.equal(legacyTarget("/hosts/new", q()), "/hosts?add=1");
  });

  it("splits the retired /access page into People, API keys and Secrets", () => {
    assert.equal(legacyTarget("/access", q()), "/people");
    assert.equal(legacyTarget("/access", q(), "#people"), "/people");
    assert.equal(legacyTarget("/access", q("user=7"), "#people"), "/people?user=7");
    assert.equal(legacyTarget("/access", q(), "#api-keys"), "/api-keys");
    assert.equal(legacyTarget("/access", q("dialog=new&engine=grok"), "#api-keys"), "/api-keys?dialog=new&engine=grok");
    assert.equal(legacyTarget("/access", q("dialog=new")), "/api-keys?dialog=new");
    assert.equal(legacyTarget("/access", q(), "#claude-proxy"), "/api-keys#claude-proxy");
    assert.equal(legacyTarget("/access", q(), "#configuration"), "/api-keys#configuration");
    assert.equal(legacyTarget("/access", q(), "#secrets"), "/secrets");
  });

  it("folds the six Library pages into /library", () => {
    assert.equal(legacyTarget("/skills", q()), "/library?type=skills");
    assert.equal(legacyTarget("/skills/deploy", q()), "/library/skills/deploy");
    assert.equal(legacyTarget("/subagents/reviewer", q()), "/library/subagents/reviewer");
    assert.equal(legacyTarget("/output-styles", q()), "/library?type=output-styles");
    assert.equal(legacyTarget("/instructions", q()), "/library/agent-rules");
    assert.equal(legacyTarget("/memories", q()), "/library?type=memories");
  });

  it("keeps old Authoring bookmarks valid", () => {
    assert.equal(legacyTarget("/authoring", q()), "/library?type=skills");
    assert.equal(legacyTarget("/authoring/skills/deploy", q()), "/library/skills/deploy");
    assert.equal(legacyTarget("/authoring/agents", q()), "/library/agent-rules");
    assert.equal(legacyTarget("/authoring/output-styles/brief", q()), "/library/output-styles/brief");
    assert.equal(legacyTarget("/authoring/settings", q()), "/engines#claude-client");
  });

  it("folds Account sub-pages and project tabs", () => {
    assert.equal(legacyTarget("/account/theme", q()), "/account#appearance");
    assert.equal(legacyTarget("/account/passkeys", q()), "/account#security");
    assert.equal(legacyTarget("/projects/alpha/todos", q()), "/projects/alpha/board");
    assert.equal(legacyTarget("/projects/alpha/notes", q()), "/projects/alpha/documents?kind=notes");
    assert.equal(legacyTarget("/projects/alpha/files", q()), "/projects/alpha/documents?kind=files");
    assert.equal(legacyTarget("/projects/alpha/feedback", q()), "/projects/alpha/reports");
  });

  it("leaves current URLs alone", () => {
    for (const path of ["/dashboard", "/hosts", "/hosts/3", "/agents", "/library", "/settings", "/people", "/api-keys", "/secrets", "/account", "/projects", "/projects/alpha/board"]) {
      assert.equal(legacyTarget(path, q()), null, path);
    }
  });
});
