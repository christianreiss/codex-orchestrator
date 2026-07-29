import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { NavItem } from "./nav";

// `nav.ts` pulls its icons from `@lucide/svelte`, whose components node cannot
// parse; answering every `.svelte` request with an empty module keeps the
// registry importable without a bundler.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".svelte")) {
      return { format: "module", shortCircuit: true, source: "export default function () {}" };
    }
    return nextLoad(url, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const navModule: string = "./nav.ts";
const { NAV, getDocumentTitle, getPageContext, isActive } = (await import(
  navModule
)) as typeof import("./nav");

/** The registered nav item for `href`, so the tests track the real registry. */
function navItem(href: string): NavItem {
  const item = NAV.find((candidate) => candidate.href === href);
  assert.ok(item, `NAV has no item for ${href}`);
  return item;
}

describe("isActive", () => {
  it("matches the item's own route exactly", () => {
    assert.equal(isActive(navItem("/hosts"), "/hosts"), true);
  });

  it("matches routes nested under the item", () => {
    assert.equal(isActive(navItem("/hosts"), "/hosts/42"), true);
    assert.equal(isActive(navItem("/hosts"), "/hosts/new"), true);
  });

  it("does not match a sibling route sharing the href's prefix", () => {
    assert.equal(isActive(navItem("/hosts"), "/hostsx"), false);
    assert.equal(isActive(navItem("/hosts"), "/host"), false);
    assert.equal(isActive(navItem("/api-keys"), "/api-keys-legacy"), false);
  });

  it("prefers the item's regex over the href when one is supplied", () => {
    const activity = navItem("/logs/events");
    // Sibling of the href, and the href's own parent: both only match by regex.
    assert.equal(isActive(activity, "/logs/mcp"), true);
    assert.equal(isActive(activity, "/logs"), true);
    assert.equal(isActive(activity, "/logs/events"), true);
  });

  it("keeps regex items off near-miss paths", () => {
    assert.equal(isActive(navItem("/logs/events"), "/logsx"), false);
    assert.equal(isActive(navItem("/settings"), "/settingsx"), false);
    assert.equal(isActive(navItem("/settings"), "/settings/users"), true);
  });
});

describe("getPageContext", () => {
  it("labels the empty path as the overview", () => {
    assert.equal(getPageContext("/"), "Overview");
    assert.equal(getPageContext(""), "Overview");
    assert.equal(getPageContext("/dashboard"), "Overview");
  });

  it("labels the hosts list, the register form and a host detail", () => {
    assert.equal(getPageContext("/hosts"), "Hosts");
    assert.equal(getPageContext("/hosts/new"), "Hosts / Register host");
    assert.equal(getPageContext("/hosts/42"), "Hosts / Host #42");
  });

  it("labels a project and its sub-tab", () => {
    assert.equal(getPageContext("/projects"), "Projects");
    assert.equal(getPageContext("/projects/my-app"), "Projects / My app");
    assert.equal(getPageContext("/projects/my-app/todos"), "Projects / My app / Todos");
  });

  it("labels API access", () => {
    assert.equal(getPageContext("/api-keys"), "API access");
  });

  it("defaults bare authoring to the skills section", () => {
    assert.equal(getPageContext("/authoring"), "Authoring / Skills");
    assert.equal(getPageContext("/authoring/agents"), "Authoring / Agents");
    assert.equal(getPageContext("/authoring/skills/deploy-bot"), "Authoring / Skills / Deploy bot");
  });

  it("splits the activity log by source", () => {
    assert.equal(getPageContext("/logs/mcp"), "Activity / MCP requests");
    assert.equal(getPageContext("/logs/events"), "Activity / Audit trail");
    assert.equal(getPageContext("/logs"), "Activity / Audit trail");
  });

  it("names the users tab of settings only", () => {
    assert.equal(getPageContext("/settings"), "Settings");
    assert.equal(getPageContext("/settings/users"), "Settings / Users & access");
    assert.equal(getPageContext("/settings/codex"), "Settings");
  });

  it("renames the account theme section to Appearance", () => {
    assert.equal(getPageContext("/account"), "Account");
    assert.equal(getPageContext("/account/theme"), "Account / Appearance");
    assert.equal(getPageContext("/account/passkeys"), "Account / Passkeys");
  });

  it("labels the manual index and a manual page", () => {
    assert.equal(getPageContext("/manual"), "Manual");
    assert.equal(getPageContext("/manual/quick%20start"), "Manual / Quick start");
  });

  it("labels the unauthenticated routes", () => {
    assert.equal(getPageContext("/login"), "Sign in");
    assert.equal(getPageContext("/password/reset"), "Reset password");
    assert.equal(getPageContext("/cli-auth"), "CLI authorization");
    assert.equal(getPageContext("/cli-auth/verify"), "CLI authorization");
  });

  it("keeps the raw segment when a malformed percent-escape reaches humanize", () => {
    assert.equal(getPageContext("/manual/50%-off"), "Manual / 50% off");
  });

  it("falls back to joining humanized segments for unregistered routes", () => {
    assert.equal(getPageContext("/password"), "Password");
    assert.equal(getPageContext("/whats_new/2026-07"), "Whats new / 2026 07");
  });
});

describe("getDocumentTitle", () => {
  it("suffixes the page context with the product name", () => {
    assert.equal(getDocumentTitle("/hosts/new"), "Hosts / Register host · Codex Orchestrator");
    assert.equal(getDocumentTitle("/"), "Overview · Codex Orchestrator");
  });
});

describe("navigation targets", () => {
  const routesDir = fileURLToPath(new URL("../routes", import.meta.url));
  const commandsFile = fileURLToPath(
    new URL("./components/command-palette/commands.ts", import.meta.url),
  );

  /** Segment patterns of every `+page.svelte` under `src/routes`. */
  function collectRoutes(dir: string, segments: string[], out: string[][]): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "+page.svelte")) {
      out.push(segments);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        collectRoutes(join(dir, entry.name), [...segments, entry.name], out);
      }
    }
  }

  const routes: string[][] = [];
  collectRoutes(routesDir, [], routes);

  /** True if `href` (query string stripped) resolves to one of those routes. */
  function resolves(href: string): boolean {
    const wanted = href.split("?")[0].split("/").filter(Boolean);
    return routes.some(
      (route) =>
        route.length === wanted.length &&
        route.every((segment, i) => segment.startsWith("[") || segment === wanted[i]),
    );
  }

  it("found the route tree", () => {
    assert.ok(routes.length > 10, `only ${routes.length} routes discovered under ${routesDir}`);
    assert.equal(resolves("/dashboard"), true);
    assert.equal(resolves("/hosts/42"), true);
    assert.equal(resolves("/hosts/42/nope"), false);
  });

  it("points every nav item at a real page", () => {
    for (const item of NAV) {
      assert.ok(resolves(item.href), `NAV item ${item.label} -> ${item.href} has no +page.svelte`);
    }
  });

  it("points every command-palette href at a real page", () => {
    const source = readFileSync(commandsFile, "utf8");
    const hrefs = [...source.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 12, `only ${hrefs.length} palette hrefs found in ${commandsFile}`);
    for (const href of hrefs) {
      assert.ok(resolves(href), `command-palette href ${href} has no +page.svelte`);
    }
  });
});
