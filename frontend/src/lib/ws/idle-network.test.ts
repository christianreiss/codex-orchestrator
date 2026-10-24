import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";

// An architectural guard: live state must come from owner events, not a new
// timer quietly bringing database polling back through a view's query options.
it("does not configure periodic server-state refetching", async () => {
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(ts|svelte)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
        assert.doesNotMatch(await readFile(path, "utf8"), /\brefetchInterval(?:InBackground)?\s*:/, path);
      }
    }
  }
  await inspect("src");
});
