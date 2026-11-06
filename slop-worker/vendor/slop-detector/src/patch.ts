import { mkdtemp, cp, readFile, writeFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { hash } from "./core.js";
export const Patch = z.object({
  findingIds: z.array(z.string()).min(1),
  attempt: z.number().int().min(1).max(2),
  sources: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  patch: z.string().min(1),
});
export async function verify(root: string, input: unknown, checks: string[][]) {
  const p = Patch.parse(input);
  root = path.resolve(root);
  const names = [...p.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((x) => x[1]);
  const oldNames = [...p.patch.matchAll(/^--- a\/(.+)$/gm)].map((x) => x[1]);
  if (JSON.stringify(oldNames) !== JSON.stringify(names))
    throw Error("Patch must modify the same existing paths");
  if (
    !names.length ||
    /^(?:rename |copy |GIT binary|old mode|new mode|deleted file|new file|.*120000)/m.test(
      p.patch,
    )
  )
    throw Error(
      "Only modifications of existing regular text files are supported",
    );
  for (const name of names) {
    if (
      path.isAbsolute(name) ||
      name.split("/").some((x) => x === ".." || x === ".git") ||
      !p.sources[name]
    )
      throw Error("Unsafe or unhashed patch path");
    let current = root;
    for (const part of name.split("/")) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw Error("Symlink patch target");
    }
    if (hash(await readFile(current, "utf8")) !== p.sources[name])
      throw Error(`Stale patch: ${name}`);
  }
  const temp = await mkdtemp(path.join(tmpdir(), "slop-"));
  try {
    await cp(root, temp, {
      recursive: true,
      filter: (s) =>
        ![".git", "node_modules", ".slop", "dist"].includes(path.basename(s)),
    });
    const diff = path.join(temp, ".slop-proposal.patch");
    await writeFile(diff, p.patch);
    const run = (argv: string[]) => {
      const x = spawnSync(argv[0], argv.slice(1), {
        cwd: temp,
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 1_000_000,
      });
      return {
        command: argv,
        status: x.status,
        stdout: x.stdout,
        stderr: x.stderr,
        error: x.error?.message,
      };
    };
    const applicable = run(["git", "apply", "--check", diff]);
    if (applicable.status !== 0)
      return { status: "invalid", checks: [applicable] };
    const applied = run(["git", "apply", diff]);
    if (applied.status !== 0) return { status: "invalid", checks: [applied] };
    const results = checks.map(run);
    return {
      status:
        results.length && results.every((x) => x.status === 0)
          ? "verified"
          : results.length
            ? "failed"
            : "unverified",
      findingIds: p.findingIds,
      checks: results,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
