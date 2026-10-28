import { ValidationError } from '../http/errors.js';
import type { ModelPolicy } from './model-policy.js';
import type { Host } from '../db/schema.js';
import { CLAUDE_MODEL_MIN_CLI_VERSIONS, normalizeClaudeModelReference } from './claude-models.js';
import { versionCompare } from './wrapper-bin-registry.js';

/** Catalog id for a Claude model reference: known retired ids migrate, `[1m]` is a modifier. */
function canonicalClaudeModel(model: unknown, policy?: ModelPolicy): string | undefined {
  if (typeof model !== 'string' || model.trim() === '') return undefined;
  let id = normalizeClaudeModelReference(model).replace(/\[1m\]$/i, '').toLowerCase();
  if (policy?.latest_only && Object.hasOwn(policy.replacements, id)) id = policy.replacements[id]!;
  return id;
}

export function claudeModelMinimum(model: unknown, policy?: ModelPolicy): string | undefined {
  const id = canonicalClaudeModel(model, policy);
  return id && Object.hasOwn(CLAUDE_MODEL_MIN_CLI_VERSIONS, id) ? CLAUDE_MODEL_MIN_CLI_VERSIONS[id] : undefined;
}

/** Selection checks use the observed native version; a desired pin is not evidence. */
export function assertClaudeModelVersion(model: unknown, version: unknown, param = 'settings.model', policy?: ModelPolicy): void {
  const minimum = claudeModelMinimum(model, policy);
  if (!minimum) return;
  const observed = typeof version === 'string' ? version.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] : undefined;
  if (!observed || versionCompare(observed, minimum) < 0) {
    throw new ValidationError(
      `${canonicalClaudeModel(model, policy)} requires Claude Code CLI ${minimum} or newer; observed ${observed ?? 'unreported'}. Run clx update (or cron run to report an installed version), then retry.`,
      { param },
    );
  }
}

/** Checks the effective root model after host overrides; Claude has no profiles. */
export function assertClaudeSettingsModelSupport(settings: Record<string, unknown>, host: Host | null, policy?: ModelPolicy): void {
  if (!host) return; // Fleet authoring and provisioning have no observed host yet.
  assertClaudeModelVersion(settings.model, host.claudeClientVersion, 'settings.model', policy);
}
