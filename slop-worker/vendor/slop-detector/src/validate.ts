import { createHash } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { hash, type Report } from "./core.js";
const inside = (root: string, p: string) =>
  p === root || p.startsWith(root + path.sep);
async function read(file: string) {
  try {
    if (!(await lstat(file)).isFile()) return undefined;
    return await readFile(file);
  } catch {
    return undefined;
  }
}
/**
 * Check that findings point at evidence that exists: `path:line` locations
 * must name an existing line in a project file whose content still matches
 * the scanned hash, and referenced screenshots must exist (and match their
 * recorded artifact hash). Returns error strings; never throws for bad input.
 */
export async function validateEvidence(
  root: string,
  artifactDirs: string[],
  r: Report,
): Promise<string[]> {
  const errors: string[] = [];
  root = await realpath(root);
  const lines = new Map<string, number | undefined>();
  async function lineCount(rel: string) {
    if (!lines.has(rel)) {
      const abs = path.resolve(root, rel);
      let count: number | undefined;
      if (inside(root, abs)) {
        const content = await read(abs);
        if (content) {
          const text = content.toString("utf8");
          const digest = r.sources[rel];
          if (digest && hash(text) !== digest)
            errors.push(
              `Stale location: ${rel} changed since it was scanned; rescan before reporting`,
            );
          count = text.split("\n").length;
        }
      }
      lines.set(rel, count);
    }
    return lines.get(rel);
  }
  /** Artifact keys are relative to a report directory; `../` (imports beside --out) is allowed, absolute paths are not. */
  async function artifact(name: string) {
    if (path.isAbsolute(name) || /^[a-zA-Z]:[\\/]/.test(name)) return undefined;
    for (const dir of artifactDirs) {
      const content = await read(path.resolve(dir, name));
      if (content) return content;
    }
    return undefined;
  }
  for (const [name, digest] of Object.entries(r.artifacts)) {
    const content = await artifact(name);
    if (!content) errors.push(`Missing artifact: ${name}`);
    else if (createHash("sha256").update(content).digest("hex") !== digest)
      errors.push(`Artifact changed since capture: ${name}`);
  }
  for (const f of r.findings) {
    const loc = f.location.match(/^([^\s:][^:]*?):(\d+)$/);
    if (loc && /[./\\]/.test(loc[1])) {
      const count = await lineCount(loc[1].split(path.sep).join("/"));
      const line = Number(loc[2]);
      if (count === undefined)
        errors.push(`Unknown location in ${f.id}: ${f.location}`);
      else if (line < 1 || line > count)
        errors.push(
          `Line out of range in ${f.id}: ${f.location} (file has ${count} lines)`,
        );
    }
    const shots = new Set(
      `${f.location}\n${f.evidence}`.match(/[\w@.\/-]+\.png\b/g) ?? [],
    );
    for (const shot of shots) {
      if (shot in r.artifacts || (await artifact(shot))) continue;
      // A bare file name may cite an artifact key such as ../shots/x.png.
      const byName = Object.keys(r.artifacts).filter(
        (key) => path.posix.basename(key) === path.posix.basename(shot),
      );
      if (byName.length === 1) continue;
      errors.push(
        byName.length > 1
          ? `Ambiguous screenshot in ${f.id}: ${shot} matches ${byName.join(", ")}; cite the artifact key`
          : `Missing screenshot in ${f.id}: ${shot}`,
      );
    }
  }
  return [...new Set(errors)];
}
