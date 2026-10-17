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
