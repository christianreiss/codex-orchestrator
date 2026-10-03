import type { Host } from '../db/schema.js';
import { ConflictError, ForbiddenError } from '../http/errors.js';
import { ENGINE_CODEX, ENGINE_LABELS, ENGINES, isEngine, type Engine } from '../util/engine.js';

/**
 * Fleet-wide engine master switch state (`services/engine-switch.ts`).
 * `true` = enabled; always carries all three engines.
 */
export type FleetEngineState = Readonly<Record<Engine, boolean>>;

export const ALL_ENGINES_ENABLED: FleetEngineState = Object.freeze({ codex: true, claude: true, grok: true });

/** A host's engine *assignment*. Falls back to Codex for an empty column. */
export function hostEnginesList(raw: unknown): Engine[] {
  const text = typeof raw === 'string' ? raw : '';
  const out: Engine[] = [];
  for (const part of text.split(',')) {
    const engine = part.trim().toLowerCase();
    if (isEngine(engine) && !out.includes(engine)) out.push(engine);
  }
  return out.length ? out : [ENGINE_CODEX];
}

/**
 * The engines a host may actually *use* right now: its assignment minus every
 * engine switched off fleet-wide. Unlike {@link hostEnginesList} this never
 * falls back to Codex — a Claude-only host with Claude switched off has no
 * usable engine, not a Codex one.
 */
export function activeHostEngines(raw: unknown, fleet: FleetEngineState): Engine[] {
  return hostEnginesList(raw).filter((engine) => fleet[engine]);
}

/** Engines switched off fleet-wide, in canonical order. */
export function disabledEngines(fleet: FleetEngineState): Engine[] {
  return ENGINES.filter((engine) => !fleet[engine]);
}

/** Engines switched on fleet-wide, in canonical order. */
export function enabledEngines(fleet: FleetEngineState): Engine[] {
  return ENGINES.filter((engine) => fleet[engine]);
}

/**
 * The one refusal every host-facing route uses for a fleet-disabled engine.
 * The code is the same `engine_disabled` host-level removal uses — every
 * deployed wrapper already refuses to launch on it — and `scope` tells newer
 * wrappers and operators which switch is responsible.
 */
export function fleetEngineDisabledError(engine: Engine): ForbiddenError {
  return new ForbiddenError(
    `${ENGINE_LABELS[engine]} is disabled fleet-wide by the administrator`,
    'engine_disabled',
    { scope: 'fleet', engine },
  );
}

/**
 * The admin-side counterpart: an operator action that would reach a provider,
 * the runner or a host for a switched-off engine (seeding, verifying, adding
 * the engine to a host, routing an API to it) is a conflict with fleet state,
 * not a permission problem.
 */
export function fleetEngineConflictError(engine: Engine): ConflictError {
  return new ConflictError(
    `${ENGINE_LABELS[engine]} is disabled fleet-wide; switch it on under Engines first`,
    'engine_disabled',
    { scope: 'fleet', engine },
  );
}

/**
 * Gate for every engine-scoped host route. `fleet` is required on purpose:
 * a caller cannot check the host assignment and forget the master switch.
 * The host check runs first — an engine the host does not carry at all is a
 * host-level removal, which wrappers clean up, while a fleet refusal is a
 * suspension they must keep their configuration through.
 */
export function assertHostEngineEnabled(host: Pick<Host, 'engines'>, engine: Engine, fleet: FleetEngineState): void {
  if (!hostEnginesList(host.engines).includes(engine)) {
    throw new ForbiddenError(`Engine ${engine} is disabled for this host`, 'engine_disabled', { scope: 'host', engine });
  }
  if (!fleet[engine]) throw fleetEngineDisabledError(engine);
}

/**
 * Host assignment only, deliberately ignoring the fleet switch. Reserved for
 * the few routes that must keep working through a fleet suspension: releasing
 * or heartbeating a lease a running session already holds, and uninstalling.
 */
export function assertHostEngineAssigned(host: Pick<Host, 'engines'>, engine: Engine): void {
  assertHostEngineEnabled(host, engine, ALL_ENGINES_ENABLED);
}
