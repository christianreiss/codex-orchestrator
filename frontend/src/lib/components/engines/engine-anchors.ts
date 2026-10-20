/**
 * URL-anchor routing for /engines. Rarely-changed settings live in a collapsed
 * "Advanced" disclosure per engine, which does not render its content while
 * closed, so a hash that points into one must open that disclosure first.
 *
 * Pure and import-free at runtime so `node --test` can load it.
 */
export type AnchorEngine = "codex" | "claude" | "grok";

const ENGINE_ANCHOR = /^(codex|claude|grok)-(advanced|native-settings|profile-settings)$/;
const CODEX_ONLY = new Set(["codex-async-compaction", "cdx-silent"]);

/** The engine whose Advanced disclosure holds `#hash`, or null when the hash is not inside one. */
export function advancedEngineForHash(hash: string): AnchorEngine | null {
  const id = hash.replace(/^#/, "");
  if (id === "claude-client") return "claude";
  if (CODEX_ONLY.has(id)) return "codex";
  const match = ENGINE_ANCHOR.exec(id);
  return match ? (match[1] as AnchorEngine) : null;
}

const ENGINE_TAB_ANCHOR = /^(codex|claude|grok)-(defaults|danger)$/;

/**
 * The engine tab that holds `#hash`: everything {@link advancedEngineForHash}
 * knows, plus the per-engine defaults and danger-zone anchors. Null when the hash is page-level
 * (`#engine-state`, `#defaults`) or unknown, so the current tab stays.
 */
export function tabEngineForHash(hash: string): AnchorEngine | null {
  const advanced = advancedEngineForHash(hash);
  if (advanced) return advanced;
  const match = ENGINE_TAB_ANCHOR.exec(hash.replace(/^#/, ""));
  return match ? (match[1] as AnchorEngine) : null;
}

/** Sections that used to live on /engines and moved; the hash keeps its name on the new page. */
const MOVED_ANCHORS: Record<string, string> = {
  "quota-enforcement": "/limits",
  "scaling-rules": "/limits",
  "cxx-rollout": "/settings",
  chatty: "/settings",
};

/** Base-relative `/page#hash` for a section that moved off /engines, else null. */
export function movedAnchorTarget(hash: string): string | null {
  const id = hash.replace(/^#/, "");
  const page = MOVED_ANCHORS[id];
  return page ? `${page}#${id}` : null;
}
