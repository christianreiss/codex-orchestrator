/** Native Claude Code session-only effort support, checked 2026-10-12.
 * https://code.claude.com/docs/en/model-config#adjust-effort-level
 * Keep this separate from persisted efforts: Opus/Sonnet 4.6 support max but
 * not xhigh, while older models without adaptive effort support neither.
 */
const sessionMaxModels: ReadonlySet<string> = new Set([
  'claude-fable-5-1', 'claude-fable-5',
  'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6',
  'claude-haiku-5-5',
]);

export function claudeSessionEfforts(model: string): string[] {
  return sessionMaxModels.has(model) ? ['max'] : [];
}

/** Older native CLIs still consume the pre-per-model user key on these models.
 * Opus 5.5 and releases after it deliberately ignore that legacy user key.
 */
const legacyUserEffortModels: ReadonlySet<string> = new Set([
  'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5', 'claude-sonnet-4-6',
]);

export function claudeSupportsLegacyUserEffort(model: string): boolean {
  return legacyUserEffortModels.has(model);
}
