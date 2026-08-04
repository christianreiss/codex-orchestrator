/**
 * Maps the rendered AGENTS.md document back to the settings that produced it.
 *
 * The server emits, in document order, one entry per highlightable block along
 * with every `##` heading that block's own markdown contains. This module turns
 * that list plus the headings actually present in the rendered DOM into a
 * per-heading owner, so the console can light up the text a control produced.
 *
 * The rule that keeps it honest is that matching is *monotone and by heading
 * text*: a heading is attributed only when it matches an expected heading that
 * has not been consumed yet, and the scan never moves backwards. Anything
 * unexpected — an operator who types their own `## Hard Stop Lines`, a section a
 * paste-back stripped out — comes back unattributed rather than attributed to
 * the wrong control. Guessing would be worse than not linking at all.
 *
 * The residual case this cannot resolve: if the document is *missing* a heading
 * the server said it emitted, and a later block repeats that exact heading text,
 * the later one is claimed by the earlier block. That needs the server's list and
 * the document to disagree, which they do not for anything this console renders —
 * an operator's own headings are reported as part of the block they were typed
 * into, precisely so they cannot shift the blocks after them. Resolving it
 * properly would take per-block content matching, which is only worth it if
 * pasted-back documents ever start reaching this path.
 */

export interface ProvenanceEntry {
  key: string;
  label: string;
  group: "policy" | "module" | "custom" | "feature" | "legacy";
  headings: string[];
}

/**
 * Compare on the text a reader sees, not the bytes either side stored.
 *
 * The server reads headings out of Markdown (`## Projects / CoCo`) while the
 * client reads them out of the DOM, where inline markup has already been turned
 * into elements and entities into characters. Dropping the inline markers and
 * collapsing whitespace is what makes those two views comparable.
 */
function normalizeHeading(value: string): string {
  return value
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Assign each rendered heading to the key of the block that produced it, or to
 * `null` when nothing matched.
 *
 * The returned array is parallel to `headings`. The scan only ever moves
 * forward, so a block the document does not contain is skipped rather than
 * blocking every block after it.
 */
export function assignProvenance(
  entries: readonly ProvenanceEntry[],
  headings: readonly string[],
): (string | null)[] {
  // Flatten to one slot per expected heading, remembering which block owns it.
  const slots: { key: string; heading: string }[] = [];
  for (const entry of entries) {
    for (const heading of entry.headings) {
      slots.push({ key: entry.key, heading: normalizeHeading(heading) });
    }
  }

  const out: (string | null)[] = [];
  let cursor = 0;
  for (const heading of headings) {
    const wanted = normalizeHeading(heading);
    let found = -1;
    for (let i = cursor; i < slots.length; i += 1) {
      if (slots[i]!.heading === wanted) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      out.push(null);
      continue;
    }
    out.push(slots[found]!.key);
    cursor = found + 1;
  }
  return out;
}

/** How many distinct blocks a set of keys covers, for "contributes to N blocks". */
export function countBlocks(assigned: readonly (string | null)[], keys: readonly string[]): number {
  const wanted = new Set(keys);
  const seen = new Set<string>();
  for (const key of assigned) {
    if (key !== null && wanted.has(key)) seen.add(key);
  }
  return seen.size;
}
