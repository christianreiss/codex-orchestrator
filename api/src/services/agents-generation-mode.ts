/**
 * Fleet-wide master switch for how the canonical middle of AGENTS.md/CLAUDE.md
 * is produced.
 *
 * The switch only ever changes the *middle* of a served document. The mandatory
 * policy prefix and the managed feature block are host guarantees, not editor
 * output, so no position of this switch can suppress them — `off` still serves
 * the fleet rules and the live Skills/Memory/Projects/Secrets guidance.
 *
 * It is applied at RENDER time, never at STORE time: a stored composition keeps
 * every module the operator selected regardless of the mode, so `off` is a
 * one-click, loss-free switch rather than a destructive edit.
 */
import {
  normalizeAgentPolicyComposition,
  renderAgentPolicyBase,
  type AgentPolicyComposition,
} from './agent-policy-composer.js';

export const AGENTS_GENERATION_MODE_KEY = 'agents_generation_mode';

export const AGENTS_GENERATION_MODES = ['managed', 'manual', 'off'] as const;

export type AgentsGenerationMode = (typeof AGENTS_GENERATION_MODES)[number];

export const DEFAULT_AGENTS_GENERATION_MODE: AgentsGenerationMode = 'managed';

/**
 * Strict parse for operator input: an unrecognized value is `null` so the admin
 * route can reject it, rather than silently resetting the fleet to `managed`.
 */
export function parseAgentsGenerationMode(value: unknown): AgentsGenerationMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return (AGENTS_GENERATION_MODES as readonly string[]).includes(normalized)
    ? (normalized as AgentsGenerationMode)
    : null;
}

/**
 * Read-side normalization, which FAILS OPEN.
 *
 * A missing key, a blank value, a row written by a future version, or a settings
 * lookup that threw all resolve to `managed` — today's behavior. The inverse
 * default would let one unreadable `versions` row strip the canonical base from
 * every host in the fleet at once, which is the worst outcome this switch can
 * produce and the one it must never reach by accident.
 */
export function normalizeAgentsGenerationMode(value: unknown): AgentsGenerationMode {
  return parseAgentsGenerationMode(value) ?? DEFAULT_AGENTS_GENERATION_MODE;
}

/**
 * The composition a draft contributes at this mode.
 *
 * `off` keeps the operator's custom instructions and drops the generated
 * modules, which is exactly an empty `enabled_modules` — so the one composer
 * still renders every mode and there is no second rendering path to keep byte
 * for byte in sync with it. Throws `ValidationError` on a malformed draft, the
 * same as composing it directly would.
 */
export function compositionForMode(mode: AgentsGenerationMode, composition: unknown): unknown {
  if (mode !== 'off') return composition;
  const normalized = normalizeAgentPolicyComposition(composition);
  return { ...normalized, enabled_modules: [] } satisfies AgentPolicyComposition;
}

/**
 * The canonical middle a stored row contributes at this mode.
 *
 * A row with no `builder_state` was hand-written: nothing in it was generated,
 * so `off` has nothing to drop and the body is served unchanged. The same is
 * true of a `builder_state` this version cannot parse — suppressing prose on the
 * strength of a JSON column we failed to read would be the fail-closed behavior
 * `normalizeAgentsGenerationMode` exists to avoid.
 */
export function baseBodyForMode(
  mode: AgentsGenerationMode,
  row: { body: string | null; builderState: unknown },
): string {
  const body = row.body ?? '';
  if (mode !== 'off') return body;
  if (row.builderState === null || row.builderState === undefined) return body;
  try {
    return renderAgentPolicyBase(compositionForMode('off', row.builderState)).content;
  } catch {
    return body;
  }
}
