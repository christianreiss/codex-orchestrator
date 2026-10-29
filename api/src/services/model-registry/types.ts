/** Shapes of the fleet model registry. See docs/model-registry.md. */

/** Fleet capability class, docs/model-tiers.md. */
export type ModelTier = 1 | 2 | 3 | 4 | 5;

/**
 * `active` is offered everywhere. `deprecated` is still accepted (stored
 * selections, efforts) but no longer offered. `retired` ids are never accepted;
 * a successor lists them in `upgradesFrom`.
 */
export type ModelStatus = 'active' | 'deprecated' | 'retired';

/** Anthropic Models API `line`; explicit data, never parsed from the id. */
export type ClaudeModelLine = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'mythos';

export interface ModelEntry {
  /** Native/provider model id. */
  readonly id: string;
  /** Picker label (admin UI). */
  readonly label: string;
  /**
   * Family the latest-only policy and tier fallback group by. A new version of
   * a Codex or Claude family inherits the family's tier for unknown ids.
   */
  readonly family: string;
  readonly tier: ModelTier;
  readonly status: ModelStatus;
  /** Efforts the fleet persists for this model (native CLI contract). */
  readonly efforts: readonly string[];
  /** Native default effort; null for a model without an effort control. */
  readonly defaultEffort: string | null;
  /** Oldest native CLI that offers the model (not an API minimum). */
  readonly minCliVersion?: string;
  /** Retired ids that heal to this model wherever a selection is stored or requested. */
  readonly upgradesFrom?: readonly string[];
  /** Active alternate spellings that canonicalize to this id without changing model. */
  readonly aliases?: readonly string[];
  /** Efforts valid for one launch that the fleet never persists (Claude `max`). */
  readonly sessionEfforts?: readonly string[];
  /** Claude: older native CLIs still read the top-level user `effortLevel` for it. */
  readonly legacyUserEffort?: boolean;
  /** Claude: `advisor_rank` from the native catalog (advisor gates). */
  readonly advisorRank?: number;
  /** Claude: Models API limits served by the Anthropic-compatible gateway. */
  readonly api?: { readonly maxInputTokens: number; readonly maxTokens: number; readonly line: ClaudeModelLine };
  /**
   * The provider id is not verified against a real account catalog yet. Such a
   * model is accepted for explicit authoring, but never a latest-only target,
   * not in `/v1/models`, not in the Model Class Check, and offered by the
   * launchpad only when the host's own native catalog lists it.
   */
  readonly liveCatalogRequired?: boolean;
}

export interface EngineRegistry<E extends ModelEntry = ModelEntry> {
  /** Canonical (picker) order. */
  readonly models: readonly E[];
  /** Fleet default for new configs and empty gateway requests. */
  readonly defaultModel: string;
}
