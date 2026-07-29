import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// `nav.test.ts` resolves the nav registry and the command palette against the
// route tree; this walks the rest of the SPA so that renaming or deleting a
// route directory cannot leave a hand-written link 404ing with every gate green.
describe("internal links", () => {
  const srcDir = fileURLToPath(new URL("..", import.meta.url));
  const scanDirs = [join(srcDir, "routes"), join(srcDir, "lib", "components")];

  /** `file:target` entries that deliberately point at no page, with the reason. */
  const ALLOWLIST: Record<string, string> = {};

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
  collectRoutes(join(srcDir, "routes"), [], routes);

  /** True if `path` resolves to one of those routes, `[param]` matching any segment. */
  function resolves(path: string): boolean {
    const wanted = path.split("/").filter(Boolean);
    return routes.some(
      (route) =>
        route.length === wanted.length &&
        route.every((segment, i) => segment.startsWith("[") || segment === wanted[i]),
    );
  }

  /** Every source file worth scanning, tests excluded. */
  function collectSources(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectSources(path, out);
      } else if (
        (entry.name.endsWith(".svelte") || entry.name.endsWith(".ts")) &&
        !entry.name.endsWith(".test.ts")
      ) {
        out.push(path);
      }
    }
  }

  const LINK_PATTERNS = [
    /href=\{`\$\{base\}([^`]*)`/g, // href={`${base}/hosts`}
    /href="\{base\}([^"]*)"/g, // href="{base}/hosts"
    /goto\(`\$\{base\}([^`]*)`/g, // goto(`${base}/hosts`, { … })
  ];

  const links: { file: string; target: string; path: string }[] = [];
  const sources: string[] = [];
  for (const dir of scanDirs) {
    collectSources(dir, sources);
  }
  for (const file of sources) {
    const source = readFileSync(file, "utf8");
    for (const pattern of LINK_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const target = match[1];
        // `${base}${item.href}` just forwards a NAV/tab entry, which the
        // registry's own tests cover; only a literal path says anything here.
        if (!target.startsWith("/")) continue;
        links.push({
          file: relative(srcDir, file),
          target,
          // `/hosts/${h.id}?tab=x` -> `/hosts/*`, which `resolves` matches against `[id]`.
          path: target.split("?")[0].replace(/\$\{[^}]*\}/g, "*"),
        });
      }
    }
  }

  it("found the route tree and the link sites", () => {
    assert.ok(routes.length > 10, `only ${routes.length} routes discovered under ${srcDir}`);
    assert.ok(
      links.length >= 25,
      `only ${links.length} in-app targets found across ${sources.length} files`,
    );
    assert.equal(resolves("/dashboard"), true);
    assert.equal(resolves("/hosts/42"), true);
    assert.equal(resolves("/hosts/42/nope"), false);
  });

  it("points every in-app link at a real page", () => {
    const dead = links
      .filter((link) => !resolves(link.path))
      .map((link) => `${link.file}:${link.target}`)
      .filter((entry) => !(entry in ALLOWLIST));
    assert.deepEqual(dead, [], `in-app links with no +page.svelte:\n${dead.join("\n")}`);
  });
});
