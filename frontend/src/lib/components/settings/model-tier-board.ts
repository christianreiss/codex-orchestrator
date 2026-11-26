/**
 * Draft logic of the model tier board, pure and import-free at runtime so
 * `node --test` can load it. A draft maps `engine:id` to a tier; the server
 * keeps only placements that differ from the registry default.
 */
import type { ModelTierModel } from "../../api/settings";

export type TierDraft = Record<string, number>;
type Placed = Pick<ModelTierModel, "engine" | "id" | "tier" | "default_tier">;

export const tierKey = (model: Pick<ModelTierModel, "engine" | "id">): string => `${model.engine}:${model.id}`;

/** The saved placements as a draft. */
export function draftFrom(models: readonly Placed[]): TierDraft {
  return Object.fromEntries(models.map((model) => [tierKey(model), model.tier]));
}

/** Models whose draft tier differs from the saved one. */
export function unsavedMoves(models: readonly Placed[], draft: TierDraft): number {
  return models.filter((model) => (draft[tierKey(model)] ?? model.tier) !== model.tier).length;
}

/** Models the draft places away from the registry default. */
export function deviations(models: readonly Placed[], draft: TierDraft): number {
  return models.filter((model) => (draft[tierKey(model)] ?? model.tier) !== model.default_tier).length;
}

/** The registry defaults as a draft ("Reset all to defaults"). */
export function defaultsDraft(models: readonly Placed[]): TierDraft {
  return Object.fromEntries(models.map((model) => [tierKey(model), model.default_tier]));
}

/**
 * The write body: every model's draft tier, hidden engines included, so a save
 * never drops a placement the board does not show.
 */
export function tierPayload(models: readonly Placed[], draft: TierDraft): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const model of models) (out[model.engine] ??= {})[model.id] = draft[tierKey(model)] ?? model.tier;
  return out;
}

/** One column per level, its visible models in the server's canonical order. */
export function tierColumns<M extends Placed>(
  levels: readonly { tier: number; work: string }[],
  models: readonly M[],
  draft: TierDraft,
  visible: (engine: M["engine"]) => boolean,
): { tier: number; work: string; models: M[] }[] {
  return levels.map((level) => ({
    ...level,
    models: models.filter((model) => visible(model.engine) && (draft[tierKey(model)] ?? model.tier) === level.tier),
  }));
}
