import { ValidationError } from '../http/errors.js';

export const ENGINE_CODEX = 'codex' as const;
export const ENGINE_CLAUDE = 'claude' as const;
export const ENGINE_GROK = 'grok' as const;
export const ENGINE_KIMI = 'kimi' as const;
export type Engine = typeof ENGINE_CODEX | typeof ENGINE_CLAUDE | typeof ENGINE_GROK | typeof ENGINE_KIMI;
export const ENGINES: readonly Engine[] = [ENGINE_CODEX, ENGINE_CLAUDE, ENGINE_GROK, ENGINE_KIMI];

/**
 * Engine value of external clients (docs/external-clients.md). It is NOT a
 * provider engine and is deliberately not a member of `Engine` or `ENGINES`:
 * no master switch, accounts, auth head or wrapper. It exists only as the engine
 * of sessions and addresses under the server-owned `external` host, where
 * `host-engine-policy.ts` treats it as an always-active assignment.
 */
export const ENGINE_EXTERNAL = 'external' as const;

export const ENGINE_LABELS: Record<Engine, string> = { codex: 'Codex', claude: 'Claude', grok: 'Grok', kimi: 'Kimi Code' };
export const ENGINE_COMMANDS: Record<Engine, string> = { codex: 'cdx', claude: 'clx', grok: 'cgx', kimi: 'ckx' };
export const ENGINE_HOST_FIELDS = {
  codex: { lastRefresh: 'lastRefresh', authDigest: 'authDigest', clientVersion: 'clientVersion', clientVersionOverride: 'clientVersionOverride', wrapperVersion: 'wrapperVersion', modelOverride: 'modelOverride', reasoningEffortOverride: 'reasoningEffortOverride' },
  claude: { lastRefresh: 'claudeLastRefresh', authDigest: 'claudeAuthDigest', clientVersion: 'claudeClientVersion', clientVersionOverride: 'claudeClientVersionOverride', wrapperVersion: 'claudeWrapperVersion', modelOverride: 'claudeModelOverride', reasoningEffortOverride: 'claudeReasoningEffortOverride' },
  grok: { lastRefresh: 'grokLastRefresh', authDigest: 'grokAuthDigest', clientVersion: 'grokClientVersion', clientVersionOverride: 'grokClientVersionOverride', wrapperVersion: 'grokWrapperVersion', modelOverride: 'grokModelOverride', reasoningEffortOverride: 'grokReasoningEffortOverride' },
  kimi: { lastRefresh: 'kimiLastRefresh', authDigest: 'kimiAuthDigest', clientVersion: 'kimiClientVersion', clientVersionOverride: 'kimiClientVersionOverride', wrapperVersion: 'kimiWrapperVersion', modelOverride: 'kimiModelOverride', reasoningEffortOverride: 'kimiReasoningEffortOverride' },
} as const;

export function isEngine(x: unknown): x is Engine {
  return x === ENGINE_CODEX || x === ENGINE_CLAUDE || x === ENGINE_GROK || x === ENGINE_KIMI;
}

/**
 * Read a caller-supplied engine value.
 *
 * `fallback` applies to *absence* only — `undefined`, `null`, or an empty
 * string. A value that is present but not an engine is a caller error and is
 * rejected. It used to fall through to `fallback`, which meant `{"engine":
 * "gemini"}` ran against Codex and `{"engine": "clude"}` did too: a typo
 * silently pointed a write at the wrong engine's canonical state.
 *
 * For a value read back out of the database, use `engineFromStoredValue` in
 * `engine-resolution.ts` instead — an unparseable stored column is history, not
 * a request to reject.
 */
export function parseEngine(x: unknown, fallback: Engine = ENGINE_CODEX): Engine {
  if (x === undefined || x === null) return fallback;
  if (typeof x === 'string') {
    const normalized = x.trim().toLowerCase();
    if (normalized === '') return fallback;
    if (isEngine(normalized)) return normalized;
  }
  throw new ValidationError('engine must be "codex", "claude", "grok" or "kimi"', { param: 'engine' });
}
