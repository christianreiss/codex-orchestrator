import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { CommandGroup, CommandSource } from "./commands";
import type { QuickHost, QuickProject, QuickSkill, QuickUser } from "$lib/api/quicksearch";

// `commands.ts` reaches for icons, SvelteKit virtual modules and the stores its
// `run()` handlers drive — none of which node can resolve or load on its own.
// Only the registry itself is under test here, so every one of them is answered
// with a stub; `$lib/nav` and `$lib/api/quicksearch` stay real, because the id
// uniqueness invariant and the cache keys are exactly what we want to check.
const LUCIDE_STUB = "stub:lucide";
const NAVIGATION_STUB = "stub:app-navigation";
const PATHS_STUB = "stub:app-paths";
const THEME_STUB = "stub:theme-store";
const AUTH_STUB = "stub:auth-store";
const PALETTE_STUB = "stub:palette-store";

/** Every icon `commands.ts` and `nav.ts` import; the values are never rendered. */
const ICON_NAMES = [
  "Activity",
  "BookOpen",
  "Brain",
  "FileText",
  "Fingerprint",
  "FolderKanban",
  "GitBranch",
  "HelpCircle",
  "Keyboard",
  "KeyRound",
  "Layers",
  "LayoutDashboard",
  "Lock",
  "LogOut",
  "MessageSquareShare",
  "Monitor",
  "Moon",
  "Plug",
  "Plus",
  "Server",
  "ScrollText",
  "Settings",
  "ShieldCheck",
  "Sun",
  "UserCircle",
  "Users",
  "Zap",
];

const STUB_SOURCES: Record<string, string> = {
  [LUCIDE_STUB]: ICON_NAMES.map((name) => `export const ${name} = "icon:${name}";`).join("\n"),
  [NAVIGATION_STUB]: `export function goto() {}`,
  [PATHS_STUB]: `export const base = "";`,
  [THEME_STUB]: `export function setTheme() {}`,
  [AUTH_STUB]: `export const authActions = { logout: async () => {} };`,
  [PALETTE_STUB]: `export const commandPalette = { close() {} };`,
};

const STUBBED_SPECIFIERS: Record<string, string> = {
  "@lucide/svelte": LUCIDE_STUB,
  "$app/navigation": NAVIGATION_STUB,
  "$app/paths": PATHS_STUB,
  "$lib/stores/theme": THEME_STUB,
  "$lib/stores/auth": AUTH_STUB,
  "$lib/stores/command-palette": PALETTE_STUB,
};

/** `$lib` is two directories up from this file. */
const LIB_DIR = new URL("../../", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBBED_SPECIFIERS[specifier];
    if (stub) return { url: stub, shortCircuit: true };
    // The sources want a real QueryClient, and svelte-query only re-exports the
    // one query-core defines — behind an entry point full of `.svelte` files.
    if (specifier === "@tanstack/svelte-query") {
      return nextResolve("@tanstack/query-core", context);
    }
    if (specifier.startsWith("$lib/")) {
      const url = new URL(`${specifier.slice("$lib/".length)}.ts`, LIB_DIR);
      return { url: url.href, shortCircuit: true };
    }
    // Relative imports in `src` are written the way the bundler resolves them,
    // without the extension node insists on.
    if (specifier.startsWith("./") && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = STUB_SOURCES[url];
    if (source !== undefined) {
      return { format: "module", shortCircuit: true, source };
    }
    return nextLoad(url, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, and the hooks
// above are only in force once this module body runs, so the imports have to be
// dynamic. Types come from the casts.
const queryModule: string = "@tanstack/svelte-query";
const { QueryClient } = (await import(queryModule)) as typeof import("@tanstack/svelte-query");

const quicksearchModule: string = "$lib/api/quicksearch";
const { quickSearchKeys } = (await import(
  quicksearchModule
)) as typeof import("$lib/api/quicksearch");

const navModule: string = "$lib/nav";
const { NAV } = (await import(navModule)) as typeof import("$lib/nav");

const commandsModule: string = "./commands.ts";
const { COMMAND_GROUPS, STATIC_COMMANDS, buildDynamicSources, buildRecentCommands, groupOrder } =
  (await import(commandsModule)) as typeof import("./commands");

interface SeedRows {
  hosts?: QuickHost[];
  projects?: QuickProject[];
  skills?: QuickSkill[];
  users?: QuickUser[];
}

const clients: InstanceType<typeof QueryClient>[] = [];

/**
 * The four sources bound to a QueryClient that already holds every quick-search
 * list, so `fetchQuery` serves them from the cache and no fetcher ever runs.
 */
function sourcesFor(rows: SeedRows): CommandSource[] {
  const qc = new QueryClient();
  clients.push(qc);
  qc.setQueryData(quickSearchKeys.hosts, rows.hosts ?? []);
  qc.setQueryData(quickSearchKeys.projects, rows.projects ?? []);
  qc.setQueryData(quickSearchKeys.skills, rows.skills ?? []);
  qc.setQueryData(quickSearchKeys.users, rows.users ?? []);
  return buildDynamicSources(qc);
}

/** The ids a source produces for `query`, which is how we name the rows it kept. */
async function ids(source: CommandSource, query: string): Promise<string[]> {
  return (await source(query)).map((cmd) => cmd.id);
}

/** Twenty rows, to run each source past its cap. */
function many<T>(make: (n: number) => T): T[] {
  return Array.from({ length: 20 }, (_, n) => make(n));
}

// Cached lists live on the client's gc timer; dropping them keeps the run from
// idling until it expires.
after(() => {
  for (const qc of clients) qc.clear();
});

describe("STATIC_COMMANDS", () => {
  it("gives every command a unique id", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const cmd of STATIC_COMMANDS) {
      if (seen.has(cmd.id)) duplicates.push(cmd.id);
      seen.add(cmd.id);
    }
    // A collision would silently resolve a persisted recent to another command.
    assert.deepEqual(duplicates, []);
  });

  it("puts every command in a group the palette renders", () => {
    for (const cmd of STATIC_COMMANDS) {
      assert.ok(
        (COMMAND_GROUPS as readonly string[]).includes(cmd.group),
        `${cmd.id} is in unknown group ${cmd.group}`,
      );
      assert.notEqual(groupOrder(cmd.group), -1, `${cmd.id} has no rank`);
    }
  });

  it("exposes Agent Messaging operations and its fleet switch", () => {
    const labels = STATIC_COMMANDS.map((command) => command.label);
    assert.ok(labels.includes("Go to Agent Messaging"));
    assert.ok(labels.includes("Go to Settings / Agent Messaging"));
  });
});

describe("deep-link navigation commands", () => {
  const routesDir = fileURLToPath(new URL("../../../routes", import.meta.url));

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

  // DEEP_NAV stays private to `commands.ts`; its entries are the Navigation
  // commands whose id carries the `#label` suffix that tells them apart from
  // the plain `nav:${href}` one NAV gets, so the hrefs come back off the ids.
  const deepIds = STATIC_COMMANDS.filter(
    (cmd) => cmd.group === "Navigation" && cmd.id.includes("#"),
  ).map((cmd) => cmd.id);
  const deepHrefs = deepIds.map((id) => id.slice("nav:".length).split("#")[0]);
  const navIds = NAV.map((item) => `nav:${item.href}`);

  it("found the route tree and the deep-link entries", () => {
    assert.ok(routes.length > 10, `only ${routes.length} routes discovered under ${routesDir}`);
    assert.ok(deepHrefs.length >= 10, `only ${deepHrefs.length} deep-link commands in the registry`);
    assert.equal(resolves("/dashboard"), true);
    assert.equal(resolves("/settings?tab=engines"), true);
    assert.equal(resolves("/hosts/42"), true);
    assert.equal(resolves("/hosts/42/nope"), false);
  });

  it("points every deep-link href at a real page", () => {
    // Renaming a route directory otherwise leaves the palette entry 404ing.
    for (const href of deepHrefs) {
      assert.ok(resolves(href), `deep link ${href} has no +page.svelte`);
    }
  });

  it("keeps the ids built from those hrefs clear of the NAV-derived ones", () => {
    assert.ok(navIds.length >= 5, `only ${navIds.length} NAV items to collide with`);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of [...navIds, ...deepIds]) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    assert.deepEqual(duplicates, []);
  });
});

describe("groupOrder", () => {
  it("ranks each group by its position in COMMAND_GROUPS", () => {
    COMMAND_GROUPS.forEach((group, index) => {
      assert.equal(groupOrder(group), index);
    });
  });

  it("is -1 for a group that is not declared", () => {
    assert.equal(groupOrder("Bookmarks" as CommandGroup), -1);
  });
});

describe("buildRecentCommands", () => {
  it("is empty without recorded ids", () => {
    assert.deepEqual(buildRecentCommands([]), []);
  });

  it("keeps the ids in the order they were given, not registry order", () => {
    // "theme:system" trails "action:quick-vm" in STATIC_COMMANDS.
    const recents = buildRecentCommands(["theme:system", "action:quick-vm"]);
    assert.deepEqual(
      recents.map((cmd) => cmd.id),
      ["recent:theme:system", "recent:action:quick-vm"],
    );
  });

  it("drops ids no static command answers to", () => {
    const recents = buildRecentCommands(["action:new-host", "nav:/retired", "theme:light"]);
    assert.deepEqual(
      recents.map((cmd) => cmd.id),
      ["recent:action:new-host", "recent:theme:light"],
    );
  });

  it("copies the matched command into the Recent group without touching it", () => {
    const original = STATIC_COMMANDS.find((cmd) => cmd.id === "action:open-shortcuts");
    assert.ok(original);

    const [recent] = buildRecentCommands(["action:open-shortcuts"]);
    assert.ok(recent);
    assert.equal(recent.id, "recent:action:open-shortcuts");
    assert.equal(recent.group, "Recent");
    // Shallow copy: everything else is the very same value.
    assert.equal(recent.label, original.label);
    assert.equal(recent.hint, original.hint);
    assert.equal(recent.icon, original.icon);
    assert.equal(recent.keywords, original.keywords);
    assert.equal(recent.run, original.run);

    assert.equal(original.id, "action:open-shortcuts");
    assert.equal(original.group, "Actions");
  });
});

describe("buildDynamicSources", () => {
  const HOSTS: QuickHost[] = [
    { id: 1, fqdn: "alpha.example.com", status: "online" },
    { id: 2, fqdn: "beta.example.com", status: "degraded" },
    { id: 3, fqdn: "gamma.internal", status: null },
  ];
  const PROJECTS: QuickProject[] = [
    {
      slug: "orchestrator",
      name: "Control plane",
      title: "Fleet console",
      description: "Runs everything",
    },
    { slug: "wrappers", name: null, title: null, description: null },
  ];
  const SKILLS: QuickSkill[] = [
    {
      slug: "crane-deploy",
      name: "legacy-id",
      display_name: "Ship the API",
      description: "Rolls out a build",
    },
    { slug: "triage", name: null, display_name: null, description: null },
  ];
  const USERS: QuickUser[] = [
    { id: 4242, username: "ada", name: "Ada Lovelace", email: "ada@corp.example" },
    { id: 7, username: "grace", name: null, email: null },
  ];

  const all = () => sourcesFor({ hosts: HOSTS, projects: PROJECTS, skills: SKILLS, users: USERS });

  it("exposes one source per quick-search entity", () => {
    assert.equal(all().length, 4);
  });

  describe("hosts", () => {
    const source = () => all()[0]!;

    it("filters case-insensitively on fqdn and status", async () => {
      assert.deepEqual(await ids(source(), "ALPHA"), ["host:1"]);
      assert.deepEqual(await ids(source(), "example.COM"), ["host:1", "host:2"]);
      assert.deepEqual(await ids(source(), "Degraded"), ["host:2"]);
      assert.deepEqual(await ids(source(), "nothing"), []);
    });

    it("returns every host for an empty query", async () => {
      assert.deepEqual(await ids(source(), ""), ["host:1", "host:2", "host:3"]);
    });
  });

  describe("projects", () => {
    const source = () => all()[1]!;

    it("filters case-insensitively on slug, name, title and description", async () => {
      assert.deepEqual(await ids(source(), "ORCHEST"), ["project:orchestrator"]);
      assert.deepEqual(await ids(source(), "control"), ["project:orchestrator"]);
      assert.deepEqual(await ids(source(), "CONSOLE"), ["project:orchestrator"]);
      assert.deepEqual(await ids(source(), "everything"), ["project:orchestrator"]);
      assert.deepEqual(await ids(source(), "WRAPP"), ["project:wrappers"]);
    });

    it("returns every project for an empty query", async () => {
      assert.deepEqual(await ids(source(), ""), ["project:orchestrator", "project:wrappers"]);
    });
  });

  describe("skills", () => {
    const source = () => all()[2]!;

    it("filters case-insensitively on slug, name, display_name and description", async () => {
      assert.deepEqual(await ids(source(), "CRANE-"), ["skill:crane-deploy"]);
      assert.deepEqual(await ids(source(), "legacy"), ["skill:crane-deploy"]);
      assert.deepEqual(await ids(source(), "ship the"), ["skill:crane-deploy"]);
      assert.deepEqual(await ids(source(), "ROLLS"), ["skill:crane-deploy"]);
      assert.deepEqual(await ids(source(), "Triage"), ["skill:triage"]);
    });

    it("returns every skill for an empty query", async () => {
      assert.deepEqual(await ids(source(), ""), ["skill:crane-deploy", "skill:triage"]);
    });
  });

  describe("users", () => {
    const source = () => all()[3]!;

    it("filters case-insensitively on username, name and email", async () => {
      assert.deepEqual(await ids(source(), "GRACE"), ["user:7"]);
      assert.deepEqual(await ids(source(), "lovelace"), ["user:4242"]);
      assert.deepEqual(await ids(source(), "CORP.example"), ["user:4242"]);
      // The id is not one of the searched fields.
      assert.deepEqual(await ids(source(), "4242"), []);
    });

    it("returns every user for an empty query", async () => {
      assert.deepEqual(await ids(source(), ""), ["user:4242", "user:7"]);
    });
  });

  describe("with more rows than the palette shows", () => {
    const sources = () =>
      sourcesFor({
        hosts: many((n) => ({ id: n, fqdn: `host-${n}.example.com`, status: "online" })),
        projects: many((n) => ({ slug: `project-${n}` })),
        skills: many((n) => ({ slug: `skill-${n}` })),
        users: many((n) => ({ id: n, username: `user-${n}` })),
      });

    it("caps every source at twelve results", async () => {
      for (const source of sources()) {
        assert.equal((await source("")).length, 12);
      }
    });

    it("keeps the first twelve rows, in order", async () => {
      const [hostSource] = sources();
      assert.ok(hostSource);
      assert.deepEqual(
        await ids(hostSource, "example.com"),
        Array.from({ length: 12 }, (_, n) => `host:${n}`),
      );
    });
  });
});
