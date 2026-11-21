import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Include the inputs to Vite, SvelteKit, PostCSS and Tailwind. Tailwind
// scans every matching file under src, including TypeScript test sources.
const configFiles = [
  "package.json",
  "package-lock.json",
  "postcss.config.js",
  "scripts/build-version.mjs",
  "svelte.config.js",
  "tailwind.config.ts",
  "tsconfig.json",
  "vite.config.ts",
];

export function buildVersion(root) {
  const hash = createHash("sha256");
  const files = [...configFiles];
  function collect(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory + "/" + entry.name;
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  collect("src");
  collect("static");

  for (const path of files.sort()) {
    const digest = createHash("sha256").update(readFileSync(join(root, path))).digest();
    hash.update(path).update("\0").update(digest);
  }
  return hash.digest("hex");
}
