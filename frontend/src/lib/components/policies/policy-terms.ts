/**
 * The canonical names of Settings rows, kept as search terms.
 *
 * A row's plain label is what the operator reads; its implementation name
 * (`auto-update`, `reverse DNS`, `insecure-host approvals`) is what docs, the
 * CLI and old habits use. `PolicyRow` shows the first term inside the row's
 * "More" disclosure instead of beside the label, and the command palette can
 * offer every row through `POLICY_PALETTE_ENTRIES`, so searching for the old
 * word still lands on the setting.
 *
 * Pure and import-free so `node --test` can load it.
 */
export type PolicyGroup = "hosts" | "agents" | "rollout" | "retention";

export interface PolicyTerms {
  group: PolicyGroup;
  /** The row's plain label. */
  label: string;
  /** Canonical name first, then other words the row is known by. */
  terms: readonly string[];
}

export const POLICY_TERMS: Readonly<Record<string, PolicyTerms>> = {
  "host-spawn": { group: "hosts", label: "Let agents set up new hosts", terms: ["System Spawn", "provision", "installer", "vip"] },
  "auto-update": { group: "hosts", label: "Update hosts automatically", terms: ["auto-update", "autoupdate", "upgrade", "versions"] },
  "reverse-dns": { group: "hosts", label: "Look up host names", terms: ["reverse DNS", "ptr", "dns"] },
  "insecure-approval": { group: "hosts", label: "Allow temporary-access requests", terms: ["insecure-host approvals", "insecure", "access window", "approval"] },
  "prune-policy": { group: "hosts", label: "Remove inactive hosts", terms: ["prune policy", "inactivity", "stale hosts"] },
  "api-keys-in-chat": { group: "agents", label: "Tell agents how to treat keys pasted in chat", terms: ["API keys in chat", "secrets in chat"] },
  "model-tier-check": { group: "agents", label: "Agents check their model against the task", terms: ["model-tier self-check", "tier", "underclassed"] },
  "subagent-model-selection": { group: "agents", label: "Choose models for delegated work", terms: ["subagent model selection", "delegation", "subagents"] },
  "model-tiers": { group: "agents", label: "Model tiers", terms: ["model tier placements", "tier", "model class", "drag"] },
  authorization: { group: "agents", label: "Role checks", terms: ["authorization mode", "strict", "capabilities", "rbac"] },
  "agent-sessions": { group: "agents", label: "Agent sessions", terms: ["agent portal", "transcripts", "sessions"] },
  "session-housekeeping": { group: "retention", label: "Clean up old agent sessions", terms: ["session housekeeping", "cleanup", "disk space"] },
};

/** The word a row shows in its "More" disclosure, or undefined for a row without one. */
export function policyTerm(id: string): string | undefined {
  return POLICY_TERMS[id]?.terms[0];
}

/** One command-palette entry per row: same shape as the palette's deep-link entries, minus the icon. */
export const POLICY_PALETTE_ENTRIES = Object.entries(POLICY_TERMS).map(([id, entry]) => ({
  href: `/settings?group=${entry.group}#${id}`,
  label: `Settings / ${entry.label}`,
  keywords: [...entry.terms],
}));
