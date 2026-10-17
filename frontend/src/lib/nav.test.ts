import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { NavItem } from "./nav";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".svelte")) return { format: "module", shortCircuit: true, source: "export default function () {}" };
    return nextLoad(url, context);
  },
});

const navModule: string = "./nav.ts";
const { HUBS, MOBILE_NAV_OVERFLOW, MOBILE_NAV_PRIMARY, NAV, NAV_FOOTER, NAV_SECTIONS, getBreadcrumbs, getDocumentTitle, getPageContext, hubFor, isActive } =
  (await import(navModule)) as typeof import("./nav");

function item(id: string): NavItem {
  const found = NAV.find((candidate) => candidate.id === id);
  assert.ok(found, `missing registry item ${id}`);
  return found;
}

describe("route registry", () => {
  it("groups the planned operator tasks into nine rail hubs", () => {
    assert.deepEqual(NAV_SECTIONS.map((section) => section.label), ["Operate", "Configure"]);
    assert.deepEqual(NAV_SECTIONS.flatMap((section) => section.hubs).map((hub) => hub.id), [
      "overview", "agents", "projects", "hosts", "coordination", "activity", "providers", "library", "access",
    ]);
    assert.deepEqual(HUBS.map((hub) => [hub.id, hub.items.map((entry) => entry.id)]), [
      ["overview", ["overview"]],
      ["agents", ["clients", "topology"]],
      ["projects", ["projects"]],
      ["hosts", ["hosts"]],
      ["coordination", ["agent-messaging", "schedules", "git-director", "transfers"]],
      ["activity", ["activity", "feedback"]],
      ["providers", ["provider-accounts", "engines"]],
      ["library", ["skills", "instructions", "memories", "subagents", "commands", "output-styles"]],
      ["access", ["api-access", "secrets", "admin-users", "policies"]],
    ]);
    assert.deepEqual(NAV_FOOTER.map((entry) => entry.id), ["manual", "account"]);
  });

  it("owns every page in exactly one hub or the footer, with a unique id and route", () => {
    const hubbed = HUBS.flatMap((hub) => hub.items);
    assert.equal(new Set(hubbed).size, hubbed.length, "a page appears in two hubs");
    assert.deepEqual(
      [...hubbed, ...NAV_FOOTER].map((entry) => entry.id).sort(),
      NAV.map((entry) => entry.id).sort(),
    );
    assert.equal(new Set(NAV.map((entry) => entry.id)).size, NAV.length);
    assert.equal(new Set(NAV.map((entry) => entry.route)).size, NAV.length);
    for (const hub of HUBS) {
      assert.ok(hub.items.length > 0, `${hub.id} has no pages`);
      assert.equal(hub.route, hub.items[0]?.route, `${hub.id} should link to its first page`);
    }
    for (const entry of NAV) {
      assert.equal(entry.href, entry.route, `${entry.id} compatibility href drifted from route`);
      assert.ok(entry.keywords.length > 0, `${entry.id} has no command-palette keywords`);
      assert.ok(entry.description.length > 0, `${entry.id} has no description`);
    }
  });

  it("keeps the retired Quick Settings page out of the registry", () => {
    assert.equal(NAV.some((entry) => entry.route === "/quick-settings"), false);
    assert.ok(item("engines").keywords.includes("defaults"));
  });

  it("keeps active states route-aware without prefix collisions", () => {
    assert.equal(isActive(item("hosts"), "/hosts/42"), true);
    assert.equal(isActive(item("hosts"), "/hostsx"), false);
    assert.equal(isActive(item("activity"), "/logs/mcp"), true);
    assert.equal(isActive(item("activity"), "/logsx"), false);
    assert.equal(isActive(item("engines"), "/engines#claude-client"), false);
    assert.equal(isActive(item("account"), "/account/password"), true);
    assert.equal(isActive(item("account"), "/account/passkeys"), true);
    assert.equal(isActive(item("account"), "/account/theme"), true);
    assert.equal(isActive(item("account"), "/accounting"), false);
  });

  it("lights the rail hub for any page it owns, including detail routes", () => {
    const hubIdFor = (path: string) => hubFor(path)?.id;
    assert.equal(hubIdFor("/topology"), "agents");
    assert.equal(hubIdFor("/clients"), "agents");
    assert.equal(hubIdFor("/secrets"), "access");
    assert.equal(hubIdFor("/policies"), "access");
    assert.equal(hubIdFor("/logs/mcp"), "activity");
    assert.equal(hubIdFor("/feedback"), "activity");
    assert.equal(hubIdFor("/skills/deploy-bot"), "library");
    assert.equal(hubIdFor("/engines"), "providers");
    assert.equal(hubIdFor("/hosts/42"), "hosts");
    assert.equal(hubIdFor("/account/theme"), undefined);
    assert.equal(isActive(HUBS.find((hub) => hub.id === "coordination")!, "/git-director"), true);
    assert.equal(isActive(HUBS.find((hub) => hub.id === "coordination")!, "/git-directorx"), false);
  });

  it("keeps exactly four frequent destinations in the mobile bar", () => {
    assert.deepEqual(MOBILE_NAV_PRIMARY.map((entry) => entry.id), ["overview", "hosts", "projects", "agents"]);
    assert.deepEqual(
      [...MOBILE_NAV_PRIMARY, ...MOBILE_NAV_OVERFLOW].map((entry) => entry.id).sort(),
      HUBS.map((entry) => entry.id).sort(),
    );
  });
});

describe("location text", () => {
  it("uses direct task labels and preserves useful detail breadcrumbs", () => {
    assert.equal(getPageContext("/engines"), "Engines");
    assert.equal(getPageContext("/api-keys"), "API Access");
    assert.equal(getPageContext("/skills/deploy-bot"), "Skills / Deploy bot");
    assert.equal(getPageContext("/projects/fleet/todos"), "Projects / Fleet / Todos");
    assert.equal(getPageContext("/logs/mcp"), "Logs / MCP requests");
    assert.deepEqual(getBreadcrumbs("/projects/fleet/todos"), [
      { label: "Projects", route: "/projects" },
      { label: "Fleet", route: "/projects/fleet" },
      { label: "Todos" },
    ]);
    assert.deepEqual(getBreadcrumbs("/logs/mcp"), [
      { label: "Logs", route: "/logs/events" },
      { label: "MCP requests" },
    ]);
  });
});

describe("navigation targets", () => {
  const routesDir = fileURLToPath(new URL("../routes", import.meta.url));
  const routes: string[][] = [];
  function collect(dir: string, segments: string[]): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "+page.svelte")) routes.push(segments);
    for (const entry of entries) if (entry.isDirectory()) collect(join(dir, entry.name), [...segments, ...(/^\(.*\)$/.test(entry.name) ? [] : [entry.name])]);
  }
  collect(routesDir, []);
  function resolves(path: string): boolean {
    const wanted = path.split("?")[0].split("/").filter(Boolean);
    return routes.some((route) => route.length === wanted.length && route.every((segment, index) => segment.startsWith("[") || segment === wanted[index]));
  }

  it("backs every direct registry route with a Svelte page", () => {
    assert.ok(routes.length > 20, "expected the canonical route set");
    for (const entry of NAV) assert.equal(resolves(entry.route), true, `${entry.id} -> ${entry.route} has no page`);
  });
});
