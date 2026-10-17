/** Tab addressing for /engines: URL hash <-> (tab, sub-tab), including the pre-tab anchor ids. */
export const ENGINE_PAGE_TABS = ["fleet", "defaults", "codex", "claude", "grok"] as const;
export type EnginePageTab = (typeof ENGINE_PAGE_TABS)[number];
export const ENGINE_SUB_TABS = ["models", "versions", "native", "client", "danger"] as const;
export type EngineSubTab = (typeof ENGINE_SUB_TABS)[number];

export type EngineTabTarget = { tab: EnginePageTab; sub: EngineSubTab | null };

const LEGACY_ANCHORS: Record<string, EngineTabTarget> = {
  "engine-state": { tab: "fleet", sub: null },
  "cxx-rollout": { tab: "fleet", sub: null },
  "quota-enforcement": { tab: "fleet", sub: null },
  chatty: { tab: "fleet", sub: null },
  "codex-defaults": { tab: "codex", sub: "models" },
  "claude-defaults": { tab: "claude", sub: "models" },
  "grok-defaults": { tab: "grok", sub: "models" },
  "claude-client": { tab: "claude", sub: "client" },
};

const isTab = (v: string): v is EnginePageTab => (ENGINE_PAGE_TABS as readonly string[]).includes(v);
const isSub = (v: string): v is EngineSubTab => (ENGINE_SUB_TABS as readonly string[]).includes(v);

/** Resolves `#codex`, `#codex/versions` or an old anchor id; null when the hash names nothing known. */
export function resolveEngineHash(hash: string): EngineTabTarget | null {
  const raw = hash.replace(/^#/, "");
  if (raw in LEGACY_ANCHORS) return LEGACY_ANCHORS[raw];
  const [tab, sub] = raw.split("/");
  if (!isTab(tab)) return null;
  return { tab, sub: sub && isSub(sub) ? sub : null };
}

export function engineHash(tab: EnginePageTab, sub: EngineSubTab | null): string {
  return sub ? `#${tab}/${sub}` : `#${tab}`;
}
