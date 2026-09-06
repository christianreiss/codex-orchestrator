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
  { label: "Fable 5.1", value: "claude-fable-5-1" },
  { label: "Fable 5", value: "claude-fable-5" },
  { label: "Opus 5", value: "claude-opus-5" },
  { label: "Opus 4.8", value: "claude-opus-4-8" },
  { label: "Sonnet 5", value: "claude-sonnet-5" },
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
  { label: "GPT-6 Astra", value: "gpt-6-astra" },
  { label: "GPT-5.6 Sol", value: "gpt-5.6-sol" },
  { label: "GPT-5.6 Terra", value: "gpt-5.6-terra" },
  { label: "GPT-5.6 Luna", value: "gpt-5.6-luna" },
  { label: "GPT-5.5", value: "gpt-5.5" },
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
  { label: "Fable", value: "fable" },
];

/**
 * Fleet default for the Claude `permissions.defaultMode` settings.json key.
 * `auto` = Claude Code auto-approves tool calls with background safety checks.
 * Keep in lock-step with DEFAULT_CLAUDE_PERMISSION_MODE in
 * api/src/services/config-normalizer.ts.
 */
export const DEFAULT_CLAUDE_PERMISSION_MODE = "auto";

/**
 * Choices for the Claude `permissions.defaultMode` key. Values are exactly the
 * `--permission-mode` choices the upstream `claude` CLI accepts; keep in
 * lock-step with CLAUDE_PERMISSION_MODES in
 * api/src/services/config-normalizer.ts. Unlike model/advisor there is no
 * "off"/inherit sentinel — there is always an effective mode (auto by default).
 */
export const CLAUDE_PERMISSION_MODES: ModelOption[] = [
  { label: "Auto (auto-approve)", value: "auto" },
  { label: "Manual (prompt every time)", value: "manual" },
  { label: "Default (prompt) [legacy]", value: "default" },
  { label: "Accept edits", value: "acceptEdits" },
  { label: "Plan", value: "plan" },
  { label: "Don't ask", value: "dontAsk" },
  { label: "Bypass permissions", value: "bypassPermissions" },
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

// Codex reasoning-effort tiers. Keep in lock-step with the enum accepted by
// usage-scaling.ts and the host model-override route — both take a bare
// string server-side, this is the UI's canonical choice list for it.
export const REASONING_EFFORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
];

/**
 * Hook event names offered by the fleet hooks editor. A deliberate subset of the
 * 33 events claude-cli 2.1.263 accepts (its `wy` array) — these are the ones a
 * fleet-wide hook makes sense on. `SessionEnd` and `PostCompact` were missing
 * purely by omission: their counterparts `SessionStart` and `PreCompact` were
 * already offered, so a fleet could open a session or a compaction but never
 * close one.
 */
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "Notification",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
] as const;
