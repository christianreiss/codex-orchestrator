import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProvenanceEntry } from "./provenance";

// Same indirection the other unit tests use: node's runner needs the real `.ts`
// specifier, which TypeScript will not accept in a static import.
const sourceModule: string = "./provenance.ts";
const { assignProvenance, countBlocks } = (await import(sourceModule)) as typeof import("./provenance");

function entry(key: string, headings: string[], group: ProvenanceEntry["group"] = "module"): ProvenanceEntry {
  return { key, label: key, group, headings };
}

const POLICY = [
  entry("policy:fleet_identity", ["Fleet Management"], "policy"),
  entry("policy:safety_floor", ["Instruction Precedence and Safety Floor"], "policy"),
  entry("policy:hard_stops", ["Hard Stop Lines"], "policy"),
];

test("assigns each heading to the block that produced it", () => {
  const entries = [...POLICY, entry("module:security", ["Security and Trust Boundaries"])];
  const assigned = assignProvenance(entries, [
    "Fleet Management",
    "Instruction Precedence and Safety Floor",
    "Hard Stop Lines",
    "Security and Trust Boundaries",
  ]);
  assert.deepEqual(assigned, [
    "policy:fleet_identity",
    "policy:safety_floor",
    "policy:hard_stops",
    "module:security",
  ]);
});

test("a heading an operator typed into custom instructions belongs to that block", () => {
  // The server reports it as one of custom_instructions' own headings, so the
  // real Skills section that follows still lines up.
  const entries = [
    entry("custom_instructions", ["Custom Instructions", "Skills"], "custom"),
    entry("feature:skills", ["Skills"], "feature"),
  ];
  const assigned = assignProvenance(entries, ["Custom Instructions", "Skills", "Skills"]);
  assert.deepEqual(assigned, ["custom_instructions", "custom_instructions", "feature:skills"]);
});

test("a duplicate heading past its block is left unattributed, never re-attributed", () => {
  const entries = [...POLICY, entry("module:security", ["Security and Trust Boundaries"])];
  const assigned = assignProvenance(entries, [
    "Fleet Management",
    "Instruction Precedence and Safety Floor",
    "Hard Stop Lines",
    "Security and Trust Boundaries",
    "Hard Stop Lines",
  ]);
  assert.equal(assigned[4], null, "a second Hard Stop Lines must not claim the policy block again");
});

test("an unexpected heading is skipped without blocking the blocks after it", () => {
  const assigned = assignProvenance(POLICY, [
    "Fleet Management",
    "Something Nobody Declared",
    "Instruction Precedence and Safety Floor",
    "Hard Stop Lines",
  ]);
  assert.deepEqual(assigned, [
    "policy:fleet_identity",
    null,
    "policy:safety_floor",
    "policy:hard_stops",
  ]);
});

test("a block the document does not contain does not block the ones after it", () => {
  // Standing Authorizations is omitted entirely below the levels that grant
  // anything outright; the feature sections after it must still resolve.
  const entries = [
    ...POLICY,
    entry("policy:standing_authorizations", ["Standing Authorizations"], "policy"),
    entry("feature:skills", ["Skills"], "feature"),
  ];
  const assigned = assignProvenance(entries, [
    "Fleet Management",
    "Instruction Precedence and Safety Floor",
    "Hard Stop Lines",
    "Skills",
  ]);
  assert.equal(assigned[3], "feature:skills");
});

test("comparison ignores inline markup and whitespace, not identity", () => {
  const entries = [entry("module:midnight_rule", ["Midnight Rule 🧃🧯"])];
  assert.deepEqual(assignProvenance(entries, ["Midnight  Rule 🧃🧯"]), ["module:midnight_rule"]);
  assert.deepEqual(assignProvenance([entry("m", ["The `cdx` Loop"])], ["The cdx Loop"]), ["m"]);
  assert.deepEqual(assignProvenance(entries, ["Midnight Rule"]), [null]);
});

test("no entries and no headings degrade to no links rather than throwing", () => {
  assert.deepEqual(assignProvenance([], ["Fleet Management"]), [null]);
  assert.deepEqual(assignProvenance(POLICY, []), []);
});

test("resolves the real fleet headings after marked has rendered them", async () => {
  // The comparison that actually runs in the browser is server Markdown against
  // DOM text, not Markdown against Markdown. Everything else here stops one step
  // short of that, so a marked upgrade that changed entity handling or started
  // emitting heading ids would silently kill every highlight with the rest of
  // this file still green.
  const { marked } = (await import("marked")) as typeof import("marked");
  const headings = [
    "Fleet Management",
    "Instruction Precedence and Safety Floor",
    "Operating Contract (FAST)",
    "Evidence and Command Discovery",
    "Midnight Rule 🧃🧯",
    "Projects / CoCo",
    "API keys in chat",
  ];
  const html = marked.parse(headings.map((h) => `## ${h}\n\nBody.\n`).join("\n"), {
    async: false,
    gfm: true,
    breaks: false,
  }) as string;

  // Stand in for `textContent`: strip inline elements, decode the entities
  // marked escapes on the way in.
  const rendered = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((match) =>
    match[1]!
      .replace(/<[^>]+>/g, "")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  );
  assert.equal(rendered.length, headings.length, "marked must emit one h2 per heading");

  const entries = headings.map((h, i) => entry(`block:${i}`, [h]));
  assert.deepEqual(
    assignProvenance(entries, rendered),
    headings.map((_, i) => `block:${i}`),
  );
});

test("countBlocks counts distinct blocks actually present in the document", () => {
  const assigned = ["policy:safety_floor", "policy:hard_stops", "policy:hard_stops", null];
  assert.equal(countBlocks(assigned, ["policy:safety_floor", "policy:hard_stops"]), 2);
  assert.equal(countBlocks(assigned, ["policy:standing_authorizations"]), 0);
});
