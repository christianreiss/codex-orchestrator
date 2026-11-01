import { normalizeClaudeModelReference } from './claude-models.js';

/** Model-selection rules documented at code.claude.com/docs/en/model-config.
 * Resolve only fleet-authored selections and known family aliases. External CLI
 * flags/process environment and opaque provider identifiers are not inferred.
 */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function env(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value))
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => [k, String(v)]));
}

function model(value: unknown): string {
  return typeof value === 'string' ? normalizeClaudeModelReference(value).toLowerCase() : '';
}

/** Known public model spellings only; do not classify custom IDs by substring. */
export function claudeFastModeDeprecated(value: unknown): boolean {
  return /^claude-opus-4-8(?:\[1m\])?$/.test(model(value));
}

export function claudeSettingsFastModeDeprecated(value: unknown): boolean {
  const settings = record(value);
  const native = record(settings.native_settings);
  // Matches both renderers: structured env overlays native env leaf by leaf.
  const merged = { ...env(native.env), ...env(settings.env) };
  // Native model precedence: ANTHROPIC_MODEL > settings.model > default env.
  let selected = model(merged.ANTHROPIC_MODEL) || model(settings.model);
  if (!selected || selected === 'default') {
    selected = model(merged.ANTHROPIC_DEFAULT_MODEL);
    // Native ignores opusplan as a default-model environment value.
    if (selected === 'opusplan') return false;
  }
  if (claudeFastModeDeprecated(selected)) return true;
  // opusplan uses Opus for its plan phase. Specific IDs do not follow aliases.
  const alias = selected === 'opusplan' ? 'opus' : /^(opus|sonnet|haiku|fable)(?:\[1m\])?$/.exec(selected)?.[1];
  return alias ? claudeFastModeDeprecated(merged[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`]) : false;
}
