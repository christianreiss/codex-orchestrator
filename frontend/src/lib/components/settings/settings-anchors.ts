/**
 * URL routing for /settings. The page is one tab per group (`?group=`); every
 * section and row keeps its own `id`, so a link such as `/settings#retention` or
 * the old flat-page `#agent-coordination` still lands on the right row: the
 * hash names the group that holds it, and the page opens that tab first.
 *
 * Pure and import-free at runtime so `node --test` can load it.
 */
export const SETTINGS_GROUPS = ["hosts", "agents", "rollout", "retention"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export const SETTINGS_GROUP_LABEL: Record<SettingsGroup, string> = {
  hosts: "Hosts",
  agents: "Agents",
  rollout: "Rollout & tools",
  retention: "Retention",
};

const GROUP_OF_ID: Record<string, SettingsGroup> = {
  hosts: "hosts",
  "auto-update": "hosts",
  "reverse-dns": "hosts",
  "insecure-approval": "hosts",
  "host-spawn": "hosts",
  "host-lifecycle": "hosts",
  "prune-policy": "hosts",
  agents: "agents",
  "agent-sessions": "agents",
  "api-keys-in-chat": "agents",
  "model-tier-check": "agents",
  "subagent-model-selection": "agents",
  authorization: "agents",
  "agent-coordination": "agents",
  "agent-supervisor": "agents",
  chatty: "agents",
  rollout: "rollout",
  "cxx-rollout": "rollout",
  "wrapper-rollout": "rollout",
  "communicator-api": "rollout",
  rtk: "rollout",
  retention: "retention",
  "server-retention": "retention",
  "session-housekeeping": "retention",
};

export function isSettingsGroup(value: unknown): value is SettingsGroup {
  return typeof value === "string" && (SETTINGS_GROUPS as readonly string[]).includes(value);
}

/** The tab that holds `#hash`; null for an unknown id so the current tab stays. */
export function settingsGroupForHash(hash: string): SettingsGroup | null {
  let id = hash.replace(/^#/, "");
  try {
    id = decodeURIComponent(id);
  } catch {
    // A malformed escape cannot name a row; fall through to the raw text.
  }
  return Object.hasOwn(GROUP_OF_ID, id) ? GROUP_OF_ID[id]! : null;
}
