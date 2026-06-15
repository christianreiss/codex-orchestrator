/**
 * Claude model choices for fleet-managed authoring (subagents, commands,
 * settings). Values are the model ids the server stores; the empty-value
 * sentinel means "inherit" (omit the field on save).
 */
export interface ModelOption {
  label: string;
  value: string;
}

/**
 * Sentinel value representing "inherit from the caller" (no explicit model).
 * Non-empty so the Select component reliably registers selecting it; mapped to
 * `undefined`/omitted when serializing for the API.
 */
export const INHERIT_MODEL = "inherit";

// Keep in lock-step with CLAUDE_SUPPORTED_MODELS in
// api/src/services/claude-models.ts — the Anthropic-compatible inference gate
// (resolveRequestedModel 400s anything not in that list). Offering an id the
// gate rejects pins a host to a model that fails at inference time.
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { label: "Opus 4.7", value: "claude-opus-4-7" },
  { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
  { label: "Haiku 4.5", value: "claude-haiku-4-5-20251001" },
];

/** Authoring picker list: the model options prefixed with the inherit sentinel. */
export const CLAUDE_MODELS: ModelOption[] = [
  { label: "Inherit", value: INHERIT_MODEL },
  ...CLAUDE_MODEL_OPTIONS,
];

// Codex model choices. Keep in lock-step with SUPPORTED_MODELS in
// api/src/services/config-normalizer.ts. No "inherit" sentinel here: the
// per-host override picker injects its own "Standard (global)" clear option.
export const CODEX_MODELS: ModelOption[] = [
  { label: "GPT-5.5", value: "gpt-5.5" },
  { label: "GPT-5.4", value: "gpt-5.4" },
  { label: "GPT-5.4 mini", value: "gpt-5.4-mini" },
  { label: "GPT-5.3 Codex Spark", value: "gpt-5.3-codex-spark" },
];

/**
 * Sentinel value representing "advisor off" (omit `advisorModel` on save).
 * Non-empty for the same reason as INHERIT_MODEL: the Select component does not
 * reliably register selecting an empty-string item.
 */
export const ADVISOR_OFF = "off";

/**
 * Choices for the experimental Claude `advisorModel` settings.json key. The
 * ADVISOR_OFF sentinel means "off" (omit the field on save). The other values
 * are the short tier aliases Claude Code resolves to the current model version;
 * keep in lock-step with ADVISOR_MODEL_ALIASES in
 * api/src/services/config-normalizer.ts.
 */
export const ADVISOR_MODELS: ModelOption[] = [
  { label: "Off", value: ADVISOR_OFF },
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Haiku", value: "haiku" },
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

