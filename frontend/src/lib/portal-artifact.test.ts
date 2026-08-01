import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The portal bundle under public/go is committed, and nothing in CI builds it
 * (`npm run build:portal` appears in no workflow). Without this check a stale
 * bundle -- or one whose hashed filenames were half-staged, since emptyOutDir
 * deletes the previous generation -- ships silently and serves a blank page.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GO = resolve(ROOT, "public/go");

describe("committed agent portal bundle", () => {
  const shell = resolve(GO, "index.html");

  it("ships an index.html", () => {
    assert.ok(existsSync(shell), "public/go/index.html is missing — run npm run build:portal");
  });

  it("references only assets that exist on disk", () => {
    const html = readFileSync(shell, "utf8");
    const refs = [...html.matchAll(/(?:src|href)="(\/go\/[^"]+)"/g)].map((match) => match[1]!);
    assert.ok(refs.length > 0, "the shell references no assets at all");
    for (const ref of refs) {
      const path = resolve(ROOT, `public${ref}`);
      assert.ok(existsSync(path), `${ref} is referenced by the shell but not committed`);
    }
  });

  // A sourcemap here would publish the portal's full source to anyone who
  // opened /go, and the API serves this directory with immutable caching.
  it("ships no sourcemap", () => {
    const maps = readdirSync(resolve(GO, "assets")).filter((name) => name.endsWith(".map"));
    assert.deepEqual(maps, [], "sourcemaps must stay out of the published bundle");
  });

  /**
   * Tailwind tree-shakes rules inside `@layer components` whose class name
   * never appears literally in the scanned source. The presence modifiers are
   * applied as `presence-dot--{presence}`, so inside the layer all four were
   * dropped from the bundle and every agent rendered the same grey dot -- the
   * exact bug the presence work exists to fix, reintroduced silently at build
   * time. They now live outside the layer; this keeps them there.
   */
  it("ships every presence modifier, which purging would silently drop", () => {
    const css = readdirSync(resolve(GO, "assets"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => readFileSync(resolve(GO, "assets", name), "utf8"))
      .join("\n");
    for (const state of ["listening", "idle", "offline", "ended"]) {
      assert.ok(
        css.includes(`.presence-dot--${state}`),
        `.presence-dot--${state} was purged from the bundle; keep it out of @layer components`,
      );
    }
  });

  // The portal is the only surface served under a Content-Security-Policy, and
  // `style-src 'self'` blocks style attributes baked into the compiled output.
  it("bakes no literal style attribute into the compiled templates", () => {
    for (const name of readdirSync(resolve(GO, "assets")).filter((file) => file.endsWith(".js"))) {
      const source = readFileSync(resolve(GO, "assets", name), "utf8");
      const literal = source.match(/style="[^"]+"/g) ?? [];
      assert.deepEqual(literal, [], `${name} contains a style attribute the portal CSP will block`);
      assert.doesNotMatch(
        source,
        /setAttribute\(["']style["']/,
        `${name} sets a style attribute imperatively, which the portal CSP blocks`,
      );
    }
  });
});
