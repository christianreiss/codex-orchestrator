#!/usr/bin/env node
/**
 * Post-build: copy the SvelteKit static output (`build/`) into
 * `../public/admin/` while preserving the PHP gateway (`index.php`),
 * the manual content (`manual/`), and the error-page assets
 * (`error.css`, `error-logo.svg`).
 *
 * adapter-static's `pages` option writes directly to a destination but
 * the Vite build step clears the output directory first — which would
 * delete the preserved files. So we build to `frontend/build/` and merge
 * here instead.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "build");
const DEST = path.resolve(ROOT, "..", "public", "admin");

const PRESERVED = new Set([
  "index.php",
  "manual",
  "error.css",
  "error-logo.svg",
]);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function removeBuildArtefacts() {
  const entries = await fs.readdir(DEST).catch(() => []);
  for (const name of entries) {
    if (PRESERVED.has(name)) continue;
    const target = path.join(DEST, name);
    await fs.rm(target, { recursive: true, force: true });
  }
}

async function copyTree(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyTree(srcPath, dstPath);
    } else if (entry.isSymbolicLink()) {
      const link = await fs.readlink(srcPath);
      await fs.symlink(link, dstPath);
    } else {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

async function main() {
  if (!(await exists(SOURCE))) {
    console.error(`[copy-build] source missing: ${SOURCE}`);
    process.exit(1);
  }
  await fs.mkdir(DEST, { recursive: true });
  await removeBuildArtefacts();
  await copyTree(SOURCE, DEST);
  console.log(`[copy-build] wrote SvelteKit build into ${DEST}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
