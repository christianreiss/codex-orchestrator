import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { get } from "svelte/store";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const storeModule: string = "./insecure-resolutions.ts";
const {
  resolutions,
  ghostCount,
  markResolved,
  markResolvedMany,
  clearResolved,
  GHOST_MS,
  OUTCOME_LABELS,
} = (await import(storeModule)) as typeof import("./insecure-resolutions");

/** The store is a module singleton, so each test starts by emptying it. */
function reset(): void {
  for (const id of get(resolutions).keys()) clearResolved(id);
}

describe("insecure-resolutions", () => {
  beforeEach(reset);

  it("records a resolution and counts it as a ghost", () => {
    markResolved(7, "approved");
    assert.equal(get(ghostCount), 1);
    assert.equal(get(resolutions).get(7)?.outcome, "approved");
  });

  it("keeps the first outcome when the same id is marked twice", () => {
    // A local click and the WS echo of that same click both arrive; the
    // operator should see what they pressed, not whichever message won.
    markResolved(7, "denied");
    markResolved(7, "auto");
    assert.equal(get(resolutions).get(7)?.outcome, "denied");
  });

  it("ignores ids that are not finite numbers", () => {
    markResolved(undefined, "approved");
    markResolved(null, "approved");
    markResolved("7", "approved");
    markResolved(Number.NaN, "approved");
    assert.equal(get(ghostCount), 0);
  });

  it("marks a batch and ignores a non-array", () => {
    markResolvedMany([1, 2, 3], "domain");
    assert.equal(get(ghostCount), 3);
    markResolvedMany(undefined, "auto");
    assert.equal(get(ghostCount), 3);
  });

  it("clearResolved drops an optimistic mark whose mutation failed", () => {
    markResolved(9, "approved");
    clearResolved(9);
    assert.equal(get(ghostCount), 0);
  });

  it("expires a resolution after GHOST_MS", async () => {
    markResolved(11, "approved");
    assert.equal(get(ghostCount), 1);
    await new Promise((r) => setTimeout(r, GHOST_MS + 60));
    assert.equal(get(ghostCount), 0);
  });

  it("labels every outcome", () => {
    for (const outcome of ["approved", "denied", "timeout", "domain", "auto"] as const) {
      assert.ok(OUTCOME_LABELS[outcome].length > 0);
    }
  });
});
