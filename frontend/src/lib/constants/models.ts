/**
 * Claude model choices for fleet-managed authoring (subagents, commands,
 * settings). Values are the model ids the server stores; the empty-value
 * sentinel means "inherit" (omit the field on save).
 */
export interface ModelOption {
  label: string;
  value: string;
}

/** Sentinel value representing "inherit from the caller" (no explicit model). */
export const INHERIT_MODEL = "";

export const CLAUDE_MODELS: ModelOption[] = [
  { label: "Inherit", value: INHERIT_MODEL },
  { label: "Opus 4.8", value: "claude-opus-4-8" },
  { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
  { label: "Haiku 4.5", value: "claude-haiku-4-5" },
];

/** Color choices for subagents. */
export const SUBAGENT_COLORS: string[] = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
];

/** Hook event names supported by the Claude settings hooks block. */
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "Notification",
  "SubagentStop",
  "PreCompact",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
