/** Native Claude Code effort capabilities, from the fleet model registry.
 * https://code.claude.com/docs/en/model-config#adjust-effort-level
 * Session-only efforts stay separate from persisted ones: Opus/Sonnet 4.6
 * support `max` but not `xhigh`, while models without adaptive effort support neither.
 */
import { registryEntry } from './model-registry/index.js';

export function claudeSessionEfforts(model: string): string[] {
  return [...(registryEntry('claude', model)?.sessionEfforts ?? [])];
}

/** Older native CLIs still consume the pre-per-model user key on these models.
 * Opus 5.5 and releases after it deliberately ignore that legacy user key.
 */
export function claudeSupportsLegacyUserEffort(model: string): boolean {
  return registryEntry('claude', model)?.legacyUserEffort === true;
}
