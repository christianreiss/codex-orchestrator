/**
 * Pure helpers shared by the two memory stores: `mcp-memories.ts` (host-scoped
 * `mcp_memories`) and the `*Memory` methods on `host-projects.ts` (project-scoped
 * `coord_project_memories`). Both need identical tag/metadata normalization to
 * decide whether an upsert is a real change or a no-op, so the comparison rules
 * live here rather than being copied.
 */

/**
 * Tags round-trip through a JSON column, which some drivers hand back as a
 * string and some as a parsed array. Accept both; anything else is no tags.
 */
export function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((t) => typeof t === 'string' && t !== '') as string[];
  }
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((t) => typeof t === 'string' && t !== '');
      }
    } catch {
      return [];
    }
  }
  return [];
}

/** Lowercased, de-duplicated, sorted — the canonical form for comparing tag sets. */
export function sortedLowercase(items: string[]): string[] {
  const out = Array.from(new Set(items.map((t) => String(t).toLowerCase())));
  out.sort();
  return out;
}

/** Key-sorted, so metadata objects compare equal regardless of insertion order. */
export function sortedAssoc(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (value === null) return null;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
