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
const { MOBILE_NAV_OVERFLOW, MOBILE_NAV_PRIMARY, NAV, NAV_FOOTER, NAV_SECTIONS, getDocumentTitle, getPageContext, isActive } =
  (await import(navModule)) as typeof import("./nav");

function item(id: string): NavItem {
  const found = NAV.find((candidate) => candidate.id === id);
  assert.ok(found, `missing registry item ${id}`);
  return found;
}

describe("route registry", () => {
  it("has one stable direct destination for every planned operator task", () => {
    assert.deepEqual(NAV_SECTIONS.map((section) => section.label), ["Monitor", "Fleet", "Coordinate", "Knowledge", "Access"]);
    assert.deepEqual(NAV_SECTIONS.flatMap((section) => section.items).map((entry) => entry.id), [
      "overview", "activity", "hosts", "engines", "policies", "projects", "agent-messaging", "agent-portal",
      "skills", "instructions", "memories", "subagents", "commands", "output-styles", "api-access", "secrets", "admin-users",
    ]);
    assert.deepEqual(NAV_FOOTER.map((entry) => entry.id), ["manual", "account"]);
    for (const entry of NAV) {
      assert.equal(entry.href, entry.route, `${entry.id} compatibility href drifted from route`);
      assert.ok(entry.keywords.length > 0, `${entry.id} has no command-palette keywords`);
      assert.ok(entry.description.length > 0, `${entry.id} has no description`);
    }
  });

  it("keeps active states route-aware without prefix collisions", () => {
    assert.equal(isActive(item("hosts"), "/hosts/42"), true);
    assert.equal(isActive(item("hosts"), "/hostsx"), false);
    assert.equal(isActive(item("activity"), "/logs/mcp"), true);
    assert.equal(isActive(item("activity"), "/logsx"), false);
    assert.equal(isActive(item("engines"), "/engines#claude-client"), false);
  });

  it("keeps exactly four frequent destinations in the mobile bar", () => {
    assert.deepEqual(MOBILE_NAV_PRIMARY.map((entry) => entry.id), ["overview", "hosts", "projects", "activity"]);
    assert.deepEqual(
      [...MOBILE_NAV_PRIMARY, ...MOBILE_NAV_OVERFLOW].map((entry) => entry.id).sort(),
      NAV.map((entry) => entry.id).sort(),
    );
  });
});

describe("location text", () => {
  it("uses direct task labels and preserves useful detail breadcrumbs", () => {
    assert.equal(getPageContext("/engines"), "Engines");
    assert.equal(getPageContext("/api-keys"), "API Access");
    assert.equal(getPageContext("/skills/deploy-bot"), "Skills / Deploy bot");
    assert.equal(getPageContext("/projects/fleet/todos"), "Projects / Fleet / Todos");
    assert.equal(getPageContext("/logs/mcp"), "Activity / MCP requests");
    assert.equal(getDocumentTitle("/agent-portal"), "Agent Portal · Codex Orchestrator");
  });
});

describe("navigation targets", () => {
  const routesDir = fileURLToPath(new URL("../routes", import.meta.url));
  const routes: string[][] = [];
  function collect(dir: string, segments: string[]): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "+page.svelte")) routes.push(segments);
    for (const entry of entries) if (entry.isDirectory()) collect(join(dir, entry.name), [...segments, entry.name]);
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
