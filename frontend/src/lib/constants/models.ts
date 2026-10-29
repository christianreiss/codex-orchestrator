/**
 * Model choices for fleet-managed authoring and the host/engine pickers. The
 * model lists, labels, efforts and CLI floors are GENERATED from the API's
 * model registry (api/src/services/model-registry/data.ts) into
 * models.generated.ts; edit the registry and run `cd api && npm run
 * models:generate`, never the lists. This file keeps the picker sentinels and
 * the non-model choice lists.
 */
import { ADVISOR_MODEL_OPTIONS, CLAUDE_MODEL_OPTIONS, type ModelOption } from "./models.generated";

export {
  ADVISOR_MODEL_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODELS,
  DEFAULT_MODELS,
  GROK_MODEL_OPTIONS,
  MODEL_EFFORTS,
  MODEL_MIN_CLI_VERSIONS,
  type ModelEngine,
  type ModelOption,
} from "./models.generated";

/**
 * Sentinel value representing "inherit from the caller" (no explicit model).
 * Non-empty so the Select component reliably registers selecting it; mapped to
 * `undefined`/omitted when serializing for the API.
 */
export const INHERIT_MODEL = "inherit";

/** Authoring picker list: the model options prefixed with the inherit sentinel. */
export const CLAUDE_MODELS: ModelOption[] = [
  { label: "Inherit", value: INHERIT_MODEL },
  ...CLAUDE_MODEL_OPTIONS,
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
 * are the native tier aliases Claude Code resolves to the current model version,
 * generated from the registry's advisor aliases.
 */
export const ADVISOR_MODELS: ModelOption[] = [
  { label: "Off", value: ADVISOR_OFF },
  ...ADVISOR_MODEL_OPTIONS,
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
 * 33 events claude-cli 2.1.284 accepts (its `Bm` array) — these are the ones a
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
  "PostToolUseFailure",
  "SubagentStart",
  "PermissionRequest",
  "PermissionDenied",
  "TaskCompleted",
  "ConfigChange",
  "Setup",
] as const;
