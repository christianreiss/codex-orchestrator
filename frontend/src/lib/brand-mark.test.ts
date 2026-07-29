import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FRONTEND = resolve(ROOT, "frontend");
const COMPONENT = resolve(FRONTEND, "src/lib/components/brand/BrandMark.svelte");
const FAVICON = resolve(FRONTEND, "static/favicon.svg");
const PUBLIC_FAVICON = resolve(ROOT, "public/admin/favicon.svg");
const ERROR_LOGO = resolve(ROOT, "public/admin/error-logo.svg");

const SURFACES = [
  "frontend/src/lib/components/layout/Sidebar.svelte",
  "frontend/src/routes/login/+page.svelte",
  "frontend/src/routes/password/reset/+page.svelte",
  "frontend/src/routes/cli-auth/verify/+page.svelte",
] as const;

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function svelteSources(): string[] {
  const root = resolve(FRONTEND, "src");
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".svelte")) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function pathGeometry(svg: string): string[] {
  return [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*>/g)].map((match) => match[1] ?? "");
}

function circleGeometry(svg: string): string[] {
  return [...svg.matchAll(/<circle\b[^>]*>/g)].map((match) => {
    const tag = match[0];
    const attr = (name: string): string => new RegExp(`\\b${name}="([^"]+)"`).exec(tag)?.[1] ?? "";
    return `${attr("cx")},${attr("cy")},${attr("r")}`;
  });
}

describe("Switchyard brand mark", () => {
  it("replaces every placeholder letter/tile with the shared component", () => {
    for (const path of SURFACES) {
      const contents = source(path);
      assert.match(contents, /import BrandMark from "\$lib\/components\/brand\/BrandMark\.svelte";/, path);
      assert.match(contents, /<BrandMark\b/, path);
    }

    const stale = svelteSources()
      .filter((path) => />\s*C\s*</.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path));
    assert.deepEqual(stale, [], `literal C brand marks remain:\n${stale.join("\n")}`);
  });

  it("keeps the component, favicon, and fallback error asset on one silhouette", () => {
    const component = readFileSync(COMPONENT, "utf8");
    const favicon = readFileSync(FAVICON, "utf8");
    const errorLogo = readFileSync(ERROR_LOGO, "utf8");

    for (const [name, contents] of [
      ["component", component],
      ["favicon", favicon],
      ["error logo", errorLogo],
    ] as const) {
      assert.match(contents, /viewBox="0 0 32 32"/, `${name} viewBox`);
      assert.doesNotMatch(contents, /<text\b/i, `${name} must not fall back to a letter glyph`);
      assert.equal(pathGeometry(contents).length, 3, `${name} rail geometry`);
      assert.equal(circleGeometry(contents).length, 2, `${name} persona nodes`);
    }

    assert.deepEqual(pathGeometry(favicon), pathGeometry(component));
    assert.deepEqual(pathGeometry(errorLogo), pathGeometry(component));
    assert.deepEqual(circleGeometry(favicon), circleGeometry(component));
    assert.deepEqual(circleGeometry(errorLogo), circleGeometry(component));
  });

  it("commits the exact favicon that the static build publishes", () => {
    const favicon = readFileSync(FAVICON, "utf8");
    assert.equal(readFileSync(PUBLIC_FAVICON, "utf8"), favicon);
    assert.equal(readFileSync(ERROR_LOGO, "utf8"), favicon);
  });
});
