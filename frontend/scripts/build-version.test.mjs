import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildVersion } from "./build-version.mjs";

test("release detection is reproducible and follows source, configuration, dependencies and assets", (t) => {
  const files = [
    "src/routes/+page.svelte", "src/app.css", "static/favicon.svg",
    "package.json", "package-lock.json", "postcss.config.js", "scripts/build-version.mjs",
    "svelte.config.js", "tailwind.config.ts", "tsconfig.json", "vite.config.ts",
  ];
  function createFixture(paths) {
    const root = mkdtempSync(join(tmpdir(), "admin-build-version-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const path of paths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), path);
    }
    return root;
  }
  const first = createFixture(files);
  const second = createFixture([...files].reverse());
  const version = buildVersion(first);
  assert.equal(buildVersion(second), version);
  writeFileSync(join(second, "README.md"), "release notes");
  assert.equal(buildVersion(second), version);
  for (const path of files) {
    writeFileSync(join(second, path), "changed");
    assert.notEqual(buildVersion(second), version, path);
    writeFileSync(join(second, path), path);
  }
  rmSync(join(second, "src/app.css"));
  assert.notEqual(buildVersion(second), version);
});
