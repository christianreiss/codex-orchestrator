// GENERATED from api/src/services/model-registry/data.ts — do not edit.
// Regenerate with `cd api && npm run models:generate`; the API contract test
// test/unit/contract/frontend-model-registry.test.ts fails while this file is stale.

/** A picker choice: the stored model id and its label. */
export interface ModelOption {
  label: string;
  value: string;
}

export type ModelEngine = "codex" | "claude" | "grok";

/** Claude models the fleet offers, in picker order. */
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { label: "Fable 5.1", value: "claude-fable-5-1" },
  { label: "Fable 5", value: "claude-fable-5" },
  { label: "Opus 5.5", value: "claude-opus-5-5" },
  { label: "Opus 5", value: "claude-opus-5" },
  { label: "Opus 4.8", value: "claude-opus-4-8" },
  { label: "Sonnet 5.5", value: "claude-sonnet-5-5" },
  { label: "Sonnet 5", value: "claude-sonnet-5" },
  { label: "Opus 4.7", value: "claude-opus-4-7" },
  { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
  { label: "Haiku 5.5", value: "claude-haiku-5-5" },
  { label: "Opus 4.6", value: "claude-opus-4-6" },
  { label: "Opus 4.5", value: "claude-opus-4-5-20251101" },
  { label: "Haiku 4.5", value: "claude-haiku-4-5-20251001" },
];

/** Codex models the fleet offers, in picker order. */
export const CODEX_MODELS: ModelOption[] = [
  { label: "GPT-6.1 Sol", value: "gpt-6.1-sol" },
  { label: "GPT-6.1 Terra", value: "gpt-6.1-terra" },
  { label: "GPT-6 Astra", value: "gpt-6-astra" },
  { label: "GPT-6 Sol", value: "gpt-6-sol" },
  { label: "GPT-6 Luna", value: "gpt-6-luna" },
  { label: "GPT-5.6 Sol", value: "gpt-5.6-sol" },
  { label: "GPT-5.6 Terra", value: "gpt-5.6-terra" },
  { label: "GPT-5.6 Luna", value: "gpt-5.6-luna" },
];

/** Grok Build subscription models the fleet offers, in picker order. */
export const GROK_MODEL_OPTIONS: ModelOption[] = [
  { label: "Grok 4.7", value: "grok-4.7" },
  { label: "Grok 4.7 Fast", value: "grok-4.7-build-fast" },
  { label: "Grok 4.6", value: "grok-4.6" },
  { label: "Grok 4.5", value: "grok-4.5" },
];

/** Native Claude advisor aliases (settings.json `advisorModel`). */
export const ADVISOR_MODEL_OPTIONS: ModelOption[] = [
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Fable", value: "fable" },
];

/** Fleet default model per engine (new configs, empty gateway requests). */
export const DEFAULT_MODELS: Record<ModelEngine, string> = {
  codex: "gpt-6-astra",
  claude: "claude-sonnet-5",
  grok: "grok-4.7",
};

/** Persisted native efforts per model. */
export const MODEL_EFFORTS: Record<ModelEngine, Record<string, string[]>> = {
  codex: {
    "gpt-6.1-sol": ["low","medium","high","xhigh","max","ultra"],
    "gpt-6.1-terra": ["low","medium","high","xhigh","max","ultra"],
    "gpt-6-astra": ["low","medium","high","xhigh","max","ultra"],
    "gpt-6-sol": ["low","medium","high","xhigh","max","ultra"],
    "gpt-6-luna": ["low","medium","high","xhigh","max"],
    "gpt-5.6-sol": ["low","medium","high","xhigh","max","ultra"],
    "gpt-5.6-terra": ["low","medium","high","xhigh","max","ultra"],
    "gpt-5.6-luna": ["low","medium","high","xhigh","max"],
  },
  claude: {
    "claude-fable-5-1": ["low","medium","high","xhigh"],
    "claude-fable-5": ["low","medium","high","xhigh"],
    "claude-opus-5-5": ["low","medium","high","xhigh"],
    "claude-opus-5": ["low","medium","high","xhigh"],
    "claude-opus-4-8": ["low","medium","high","xhigh"],
    "claude-sonnet-5-5": ["low","medium","high","xhigh"],
    "claude-sonnet-5": ["low","medium","high","xhigh"],
    "claude-opus-4-7": ["low","medium","high","xhigh"],
    "claude-sonnet-4-6": ["low","medium","high"],
    "claude-haiku-5-5": ["low","medium","high","xhigh"],
    "claude-opus-4-6": ["low","medium","high"],
    "claude-opus-4-5-20251101": [],
    "claude-haiku-4-5-20251001": [],
  },
  grok: {
    "grok-4.7": ["low","medium","high","xhigh"],
    "grok-4.7-build-fast": ["low","medium","high","xhigh"],
    "grok-4.6": ["low","medium","high","xhigh"],
    "grok-4.5": ["low","medium","high"],
  },
};

/** Oldest native CLI that offers a model; absent means no documented floor. */
export const MODEL_MIN_CLI_VERSIONS: Record<ModelEngine, Record<string, string>> = {
  codex: {
    "gpt-6.1-terra": "0.159.0",
  },
  claude: {
    "claude-fable-5-1": "2.1.257",
    "claude-opus-5-5": "2.1.280",
    "claude-sonnet-5-5": "2.1.284",
    "claude-haiku-5-5": "2.1.293",
  },
  grok: {},
};
