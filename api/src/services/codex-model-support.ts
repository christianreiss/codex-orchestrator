import { ValidationError } from '../http/errors.js';
import type { ModelPolicy } from './model-policy.js';
import type { Host } from '../db/schema.js';
import { CODEX_MODEL_MIN_CLI_VERSIONS } from './codex-model-capabilities.js';
import { versionCompare } from './wrapper-bin-registry.js';

/** Selection checks use observed native versions; desired pins are not evidence. */
export function assertCodexModelVersion(model: unknown, version: unknown, param = 'settings.model'): void {
  const minimum = typeof model === 'string' ? CODEX_MODEL_MIN_CLI_VERSIONS[model.trim()] : undefined;
  if (!minimum) return;
  const observed = typeof version === 'string' ? version.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] : undefined;
  if (!observed || versionCompare(observed, minimum) < 0) {
    throw new ValidationError(`${model} requires Codex CLI ${minimum} or newer; observed ${observed ?? 'unreported'}. Run cdx update (or cron run to report an installed version), then retry.`, { param });
  }
}

export function assertCodexSettingsModelSupport(settings: Record<string, unknown>, host: Host | null, policy?: ModelPolicy): void {
  if (!host) return; // Fleet authoring and provisioning have no observed host yet.
  const effective = (model: unknown) => typeof model === 'string' && policy?.latest_only && Object.hasOwn(policy.replacements, model) ? policy.replacements[model] : model;
  assertCodexModelVersion(effective(settings.model), host.clientVersion);
  if (Array.isArray(settings.profiles)) settings.profiles.forEach((value, index) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      assertCodexModelVersion(effective((value as Record<string, unknown>).model), host.clientVersion, `settings.profiles[${index}].model`);
    }
  });
}
