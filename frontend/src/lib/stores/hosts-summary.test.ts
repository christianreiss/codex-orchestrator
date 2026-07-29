import assert from "node:assert/strict";
import { describe, it } from "node:test";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const storeModule: string = "./hosts-summary.ts";
const { hostsSummary } = (await import(storeModule)) as typeof import("./hosts-summary");

/** The badge count the store is currently broadcasting to its subscribers. */
function activeWindows(): number {
  let seen = Number.NaN;
  const unsubscribe = hostsSummary.subscribe((s) => {
    seen = s.activeInsecureWindows;
  });
  unsubscribe();
  return seen;
}

// The store is a module singleton, so its untouched value has to be read
// before any test writes to it.
const initialWindows = activeWindows();

describe("hostsSummary", () => {
  it("starts with no active windows", () => {
    assert.equal(initialWindows, 0);
  });

  it("keeps a plain count as given", () => {
    hostsSummary.setActiveInsecureWindows(3);
    assert.equal(activeWindows(), 3);
  });

  it("clamps a negative count to zero", () => {
    hostsSummary.setActiveInsecureWindows(-2);
    assert.equal(activeWindows(), 0);
  });

  it("truncates a fractional count towards zero", () => {
    hostsSummary.setActiveInsecureWindows(2.7);
    assert.equal(activeWindows(), 2);
    hostsSummary.setActiveInsecureWindows(-0.5);
    assert.equal(activeWindows(), 0);
  });

  it("falls back to zero for non-finite counts", () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      hostsSummary.setActiveInsecureWindows(4);
      hostsSummary.setActiveInsecureWindows(n);
      assert.equal(activeWindows(), 0);
    }
  });
});
