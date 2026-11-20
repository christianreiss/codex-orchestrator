import assert from "node:assert/strict";
import { it } from "node:test";

const termsPath: string = "./policy-terms.ts";
const anchorsPath: string = "../settings/settings-anchors.ts";
const { POLICY_TERMS, POLICY_PALETTE_ENTRIES, policyTerm } = await import(termsPath) as typeof import("./policy-terms");
const { settingsGroupForHash } = await import(anchorsPath) as typeof import("../settings/settings-anchors");

it("files every setting under the tab that holds its row", () => {
  for (const [id, entry] of Object.entries(POLICY_TERMS)) assert.equal(settingsGroupForHash(`#${id}`), entry.group, id);
});

it("names a canonical term first and offers the palette one entry per row", () => {
  assert.equal(policyTerm("auto-update"), "auto-update");
  assert.equal(policyTerm("insecure-approval"), "insecure-host approvals");
  assert.equal(policyTerm("not-a-row"), undefined);
  assert.equal(POLICY_PALETTE_ENTRIES.length, Object.keys(POLICY_TERMS).length);
  const entry = POLICY_PALETTE_ENTRIES.find((item) => item.href === "/settings?group=hosts#reverse-dns");
  assert.ok(entry);
  assert.ok(entry.keywords.includes("reverse DNS"));
  assert.ok(entry.label.startsWith("Settings / "));
});
