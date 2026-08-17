/**
 * The console's capability list is a copy of the API's, and a copy is a thing
 * that drifts.
 *
 * The failure mode is quiet in both directions. Rename a capability on the
 * server and the console keeps checking the old name: `can()` answers false
 * forever, and an owner watches a button they are entitled to stay disabled
 * with no error anywhere. Add one on the server and the console never offers
 * the control at all. Neither shows up as a red test, a console error, or a
 * failed request — the UI simply, silently, does less than the operator's role
 * allows.
 *
 * So this reads the vocabulary out of `api/src/security/capabilities.ts` and
 * requires the two lists to be identical.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs an extension TypeScript rejects statically; hiding it behind a
// variable keeps both happy, as the other suites here do.
const capabilitiesModule = "./capabilities.ts";
const { CAPABILITIES } = (await import(capabilitiesModule)) as typeof import("./capabilities");

const HERE = dirname(fileURLToPath(import.meta.url));
const API_CAPABILITIES = resolve(HERE, "../../../../api/src/security/capabilities.ts");

/** The string members of the `CAPABILITIES` tuple in the API source. */
function apiCapabilities(): string[] {
  const source = readFileSync(API_CAPABILITIES, "utf8");
  const start = source.indexOf("export const CAPABILITIES = [");
  assert.notEqual(start, -1, "no CAPABILITIES tuple in api/src/security/capabilities.ts");
  const end = source.indexOf("] as const;", start);
  assert.notEqual(end, -1, "CAPABILITIES tuple is not terminated");
  const body = source.slice(start, end);
  // Only quoted members; the block is heavily commented and every comment in it
  // mentions capability-shaped words.
  const withoutComments = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'/g)].map((m) => m[1]);
}

describe("frontend capability vocabulary", () => {
  it("finds the API's list", () => {
    const api = apiCapabilities();
    // A parser that silently matched nothing would make every check below pass.
    assert.ok(api.length > 20, `only found ${api.length} capabilities in the API source`);
    assert.ok(api.includes("secrets.reveal"));
  });

  it("matches the API's list exactly", () => {
    assert.deepEqual(
      [...CAPABILITIES].sort(),
      apiCapabilities().sort(),
      "mirror api/src/security/capabilities.ts in src/lib/auth/capabilities.ts",
    );
  });

  it("preserves the API's order, so the two files read the same", () => {
    assert.deepEqual([...CAPABILITIES], apiCapabilities());
  });
});
