/**
 * Staged cxx rollout: canary hosts first, then percentage waves.
 *
 * A deploy flips the manifest's `current` for the whole fleet at once. With
 * `CXX_WRAPPER_ROLLOUT_ENABLED` on, boot records that flip as a rollout
 * instead, and each host's *effective* cxx target is gated here: a host that
 * has not been admitted yet keeps being told `from_version`, which it already
 * runs, so neither cron nor the communicator updater moves it.
 *
 * Two call sites must agree, because the communicator updater only applies a
 * release when they do: `/cron/check` (routes/host) and the signed config's
 * `wrapper` block (wrapper-config.ts). Both call {@link resolveHostWrapperTarget}
 * on the same loaded state. A disagreement fails safe — no update.
 *
 * Membership is a stored list of admitted host ids rather than a hash test at
 * call time: the gate stays a pure lookup, a small fleet still moves one host
 * per wave, and an admitted host never drops out of the set again.
 *
 * Lag is not failure. A busy host waits for its agents to finish before it
 * applies anything, so stragglers never block or halt a rollout. A wave
 * advances once its soak time has passed and at least one admitted host runs
 * the target. The only automatic halt is owner churn: a new-version
 * communicator that keeps dying. That signal lives in the in-memory topology
 * registry and resets with the API; the operator's halt is the real control.
 *
 * State is one JSON blob in the `versions` K/V table (`longtext`), like
 * `setup_wizard_state`. Halting never reverts a host; `cxx update` refuses
 * downgrades anyway, and a real rollback is still a manifest revert, which
 * cancels the rollout at the next boot.
 */

import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { hosts as hostsTable, logs as logsTable, versions as versionsTable } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import {
  communicatorRegistry,
  type CommunicatorRegistry,
} from './topology/communicator-registry.js';

export const WRAPPER_ROLLOUT_KEY = 'wrapper_rollout';
/** Published on every wave advance. The communicator update trigger and its
 *  invalidation filter both react to any `version.*` event; no per-host payload. */
export const ROLLOUT_ADVANCED_EVENT = 'version.wrapper_rollout_advanced' as const;
/** Published on every other state change (start, halt, resume, complete, cancel). */
export const ROLLOUT_CHANGED_EVENT = 'version.wrapper_rollout' as const;

/** Owner restarts on the target version, per host and user within one stage, that halt a rollout. */
export const CHURN_HALT_THRESHOLD = 3;
const STATE_CACHE_MS = 3_000;
const HISTORY_LIMIT = 50;

export type RolloutStage = { kind: 'canary' } | { kind: 'percent'; percent: number };
export type RolloutStatus = 'active' | 'halted' | 'complete' | 'cancelled';

export interface WrapperRolloutState {
  id: string;
  target_version: string;
  from_version: string;
  stages: RolloutStage[];
  stage_index: number;
  stage_started_at: string;
  soak_minutes: number;
  status: RolloutStatus;
  halted_reason: string | null;
  admitted_host_ids: number[];
  started_at: string;
  updated_at: string;
  history: Array<{ at: string; event: string; by: string; detail?: string }>;
}

export interface RolloutSettings {
  enabled: boolean;
  stages: RolloutStage[];
  soakMinutes: number;
}

export interface RolloutEnv {
  CXX_WRAPPER_ROLLOUT_ENABLED?: boolean;
  CXX_WRAPPER_ROLLOUT_STAGES?: string;
  CXX_WRAPPER_ROLLOUT_SOAK_MINUTES?: number;
}

/** A host as the rollout sees it. */
export interface RolloutHost {
  id: number;
  canary: boolean;
  /** `auto_update_override = 0`: never counted, never admitted. */
  excluded: boolean;
  /** Highest cxx version the host reported over any engine, if any. */
  running: string | null;
}

// ── version comparison ──────────────────────────────────────────────────────

export function normalizeWrapperVersion(value: string): string {
  return value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? value.replace(/^v/, '');
}

/** Numeric dotted compare; a prerelease suffix sorts after its digits like `/cron/check` does. */
export function compareWrapperVersions(a: string, b: string): number {
  const pa = normalizeWrapperVersion(a).split(/[.+-]/);
  const pb = normalizeWrapperVersion(b).split(/[.+-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? '0';
    const sb = pb[i] ?? '0';
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

function isSemverish(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d/.test(normalizeWrapperVersion(value));
}

export function highestVersion(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!isSemverish(v)) continue;
    if (best === null || compareWrapperVersions(v, best) > 0) best = normalizeWrapperVersion(v);
  }
  return best;
}

// ── settings ────────────────────────────────────────────────────────────────

export const DEFAULT_ROLLOUT_STAGES = 'canary,10,50,100';
export const DEFAULT_ROLLOUT_SOAK_MINUTES = 30;

/** `canary,10,50,100` → stages. Percentages must rise and the last must be 100. */
export function parseRolloutStages(raw: string | undefined | null): RolloutStage[] {
  const parts = (raw ?? DEFAULT_ROLLOUT_STAGES)
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const stages: RolloutStage[] = [];
  let last = 0;
  for (const part of parts) {
    if (part === 'canary') {
      if (stages.length > 0) throw new Error('canary must be the first rollout stage');
      stages.push({ kind: 'canary' });
      continue;
    }
    const percent = Number(part);
    if (!Number.isInteger(percent) || percent <= last || percent > 100) {
      throw new Error(`invalid rollout stage "${part}": percentages must rise within 1..100`);
    }
    stages.push({ kind: 'percent', percent });
    last = percent;
  }
  if (last !== 100) stages.push({ kind: 'percent', percent: 100 });
  return stages;
}

export function rolloutSettingsFromEnv(env: RolloutEnv): RolloutSettings {
  const soak = env.CXX_WRAPPER_ROLLOUT_SOAK_MINUTES ?? DEFAULT_ROLLOUT_SOAK_MINUTES;
  return {
    enabled: env.CXX_WRAPPER_ROLLOUT_ENABLED === true,
    stages: parseRolloutStages(env.CXX_WRAPPER_ROLLOUT_STAGES),
    soakMinutes: Number.isFinite(soak) && soak >= 0 ? soak : DEFAULT_ROLLOUT_SOAK_MINUTES,
  };
}

// ── pure gate ───────────────────────────────────────────────────────────────

/**
 * The effective cxx version for one host. `fleetVersion` is what the manifest
 * serves to everyone; the answer is `from_version` only while an active or
 * halted rollout to exactly that version has not admitted the host and the
 * host does not already run the target. Keyed on host id alone, so every
 * engine on one host gets the same answer.
 */
export function resolveHostWrapperTarget(
  state: WrapperRolloutState | null | undefined,
  hostId: number | null | undefined,
  fleetVersion: string,
  runningVersion?: string | null,
): string {
  if (!state || (state.status !== 'active' && state.status !== 'halted')) return fleetVersion;
  if (!isSemverish(fleetVersion)) return fleetVersion;
  if (normalizeWrapperVersion(fleetVersion) !== state.target_version) return fleetVersion;
  if (hostId === null || hostId === undefined) return fleetVersion;
  if (state.admitted_host_ids.includes(hostId)) return fleetVersion;
  if (isSemverish(runningVersion) && compareWrapperVersions(runningVersion, state.target_version) >= 0) {
    return fleetVersion;
  }
  return state.from_version;
}

/** Stable per-rollout position of a host; a new release reshuffles who goes early. */
export function hostBucket(rolloutId: string, hostId: number): number {
  return createHash('sha256').update(`${rolloutId}:${hostId}`).digest().readUInt32BE(0);
}

/**
 * Host ids admitted once `stageIndex` is reached. Canary hosts are always in;
 * a percentage stage adds the first ⌈p·n/100⌉ (at least one) non-canary hosts
 * by bucket. The previous set is kept, so membership only grows.
 */
export function computeAdmitted(
  state: Pick<WrapperRolloutState, 'id' | 'stages' | 'admitted_host_ids'>,
  hosts: RolloutHost[],
  stageIndex: number,
): number[] {
  const admitted = new Set(state.admitted_host_ids);
  const eligible = hosts.filter((h) => !h.excluded);
  for (const h of eligible) if (h.canary) admitted.add(h.id);
  let percent = 0;
  for (let i = 0; i <= stageIndex && i < state.stages.length; i++) {
    const stage = state.stages[i]!;
    if (stage.kind === 'percent') percent = stage.percent;
  }
  const regular = eligible
    .filter((h) => !h.canary)
    .sort((a, b) => hostBucket(state.id, a.id) - hostBucket(state.id, b.id) || a.id - b.id);
  if (percent > 0 && regular.length > 0) {
    const count = Math.max(1, Math.ceil((percent * regular.length) / 100));
    for (const h of regular.slice(0, count)) admitted.add(h.id);
  }
  return [...admitted].sort((a, b) => a - b);
}

export function stageLabel(stage: RolloutStage | undefined): string {
  if (!stage) return 'done';
  return stage.kind === 'canary' ? 'canary' : `${stage.percent}%`;
}

/** A host runs the target, by its own report or by a live communicator. */
export function confirmedHostIds(
  state: Pick<WrapperRolloutState, 'target_version' | 'admitted_host_ids'>,
  hosts: RolloutHost[],
  liveVersions: Array<{ host_id: number; version: string }>,
): number[] {
  const admitted = new Set(state.admitted_host_ids);
  const confirmed = new Set<number>();
  for (const h of hosts) {
    if (admitted.has(h.id) && isSemverish(h.running) && compareWrapperVersions(h.running, state.target_version) >= 0) {
      confirmed.add(h.id);
    }
  }
  for (const v of liveVersions) {
    if (admitted.has(v.host_id) && isSemverish(v.version) && compareWrapperVersions(v.version, state.target_version) >= 0) {
      confirmed.add(v.host_id);
    }
  }
  return [...confirmed].sort((a, b) => a - b);
}

/**
 * Hosts whose target-version communicator owner closed on its own at least
 * {@link CHURN_HALT_THRESHOLD} times since the stage began. Admin disconnects
 * and terminations do not count.
 */
export function churningHosts(
  state: Pick<WrapperRolloutState, 'target_version' | 'stage_started_at' | 'admitted_host_ids'>,
  tombstones: Array<{ host_id: number; username: string; version: string; ended_at: string; reason: string }>,
): number[] {
  const since = Date.parse(state.stage_started_at);
  const admitted = new Set(state.admitted_host_ids);
  const counts = new Map<string, number>();
  for (const t of tombstones) {
    if (t.reason !== 'peer_closed' || !admitted.has(t.host_id)) continue;
    if (!isSemverish(t.version) || compareWrapperVersions(t.version, state.target_version) !== 0) continue;
    if (!(Date.parse(t.ended_at) >= since)) continue;
    const key = `${t.host_id}\u0000${t.username}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Set<number>();
  for (const [key, n] of counts) if (n >= CHURN_HALT_THRESHOLD) out.add(Number(key.split('\u0000')[0]));
  return [...out].sort((a, b) => a - b);
}

// ── persistence ─────────────────────────────────────────────────────────────

let cache: { at: number; state: WrapperRolloutState | null } | null = null;

/** Test seam. */
export function resetWrapperRolloutCache(): void {
  cache = null;
}

function parseState(raw: string | null | undefined): WrapperRolloutState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WrapperRolloutState;
    if (
      !parsed ||
      typeof parsed.target_version !== 'string' ||
      typeof parsed.from_version !== 'string' ||
      !Array.isArray(parsed.admitted_host_ids) ||
      !Array.isArray(parsed.stages)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Cached for a few seconds: both gate call sites run on every cron check and config bake. */
export async function loadWrapperRollout(db: Database, opts: { fresh?: boolean } = {}): Promise<WrapperRolloutState | null> {
  const now = Date.now();
  if (!opts.fresh && cache && now - cache.at < STATE_CACHE_MS) return cache.state;
  const rows = await db
    .select({ version: versionsTable.version })
    .from(versionsTable)
    .where(eq(versionsTable.name, WRAPPER_ROLLOUT_KEY))
    .limit(1);
  const state = parseState(rows[0]?.version);
  cache = { at: now, state };
  return state;
}

async function saveState(db: Database, state: WrapperRolloutState): Promise<void> {
  const at = nowIso();
  state.updated_at = at;
  if (state.history.length > HISTORY_LIMIT) state.history = state.history.slice(-HISTORY_LIMIT);
  const value = JSON.stringify(state);
  const updated = await db
    .update(versionsTable)
    .set({ version: value, updatedAt: at })
    .where(eq(versionsTable.name, WRAPPER_ROLLOUT_KEY));
  const affected = Number((updated as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
  if (affected === 0) {
    await db
      .insert(versionsTable)
      .values({ name: WRAPPER_ROLLOUT_KEY, version: value, updatedAt: at })
      .onDuplicateKeyUpdate({ set: { version: value, updatedAt: at } });
  }
  cache = { at: Date.now(), state };
}

async function logRollout(db: Database, action: string, state: WrapperRolloutState, detail: Record<string, unknown> = {}): Promise<void> {
  await db.insert(logsTable).values({
    hostId: null,
    action,
    details: JSON.stringify({
      rollout_id: state.id,
      from: state.from_version,
      target: state.target_version,
      stage: stageLabel(state.stages[state.stage_index]),
      status: state.status,
      ...detail,
    }),
    createdAt: nowIso(),
  });
}

function publishState(state: WrapperRolloutState, advanced: boolean): void {
  // No per-host data: owners re-read their own signed config and never trust this.
  const payload = { rollout_id: state.id, status: state.status, stage: stageLabel(state.stages[state.stage_index]) };
  if (advanced) wsPublisher.publish('version.wrapper_rollout_advanced', payload);
  else wsPublisher.publish('version.wrapper_rollout', payload);
}

export async function loadRolloutHosts(db: Database): Promise<RolloutHost[]> {
  const rows = await db
    .select({
      id: hostsTable.id,
      wrapperCanary: hostsTable.wrapperCanary,
      autoUpdateOverride: hostsTable.autoUpdateOverride,
      wrapperVersion: hostsTable.wrapperVersion,
      claudeWrapperVersion: hostsTable.claudeWrapperVersion,
      grokWrapperVersion: hostsTable.grokWrapperVersion,
    })
    .from(hostsTable);
  return rows.map((r) => ({
    id: r.id,
    canary: r.wrapperCanary === 1,
    excluded: r.autoUpdateOverride === 0,
    running: hostRunningWrapperVersion(r),
  }));
}

/** Highest cxx version one host reported over any engine, for the signed-config gate. */
export function hostRunningWrapperVersion(host: {
  wrapperVersion?: string | null;
  claudeWrapperVersion?: string | null;
  grokWrapperVersion?: string | null;
}): string | null {
  return highestVersion([host.wrapperVersion, host.claudeWrapperVersion, host.grokWrapperVersion]);
}

function pushHistory(state: WrapperRolloutState, event: string, by: string, detail?: string): void {
  state.history.push({ at: nowIso(), event, by, ...(detail ? { detail } : {}) });
}

// ── lifecycle ───────────────────────────────────────────────────────────────

/**
 * Boot hook: the manifest's fleet version moved from `from` to `to`. Starts a
 * rollout on an upgrade, supersedes a running one with a newer target (keeping
 * the old floor), and cancels on a downgrade. Idempotent on an unchanged target.
 */
export async function startRolloutOnPublish(
  db: Database,
  settings: RolloutSettings,
  from: string | null,
  to: string,
  by = 'deploy',
): Promise<WrapperRolloutState | null> {
  const existing = await loadWrapperRollout(db, { fresh: true });
  const live = existing && (existing.status === 'active' || existing.status === 'halted') ? existing : null;
  if (!isSemverish(to)) return existing;
  const target = normalizeWrapperVersion(to);

  if (live && compareWrapperVersions(target, live.target_version) < 0) {
    live.status = 'cancelled';
    pushHistory(live, 'cancelled', by, `fleet version went back to ${target}`);
    await saveState(db, live);
    await logRollout(db, 'wrapper.rollout.cancelled', live, { fleet_version: target });
    publishState(live, false);
    return live;
  }
  if (!settings.enabled) return existing;
  if (live && live.target_version === target) return live;
  if (!isSemverish(from) && !live) return existing;
  const floor = live ? live.from_version : normalizeWrapperVersion(from!);
  if (compareWrapperVersions(target, floor) <= 0) return existing;

  const now = nowIso();
  const state: WrapperRolloutState = {
    id: randomUUID(),
    target_version: target,
    from_version: floor,
    stages: settings.stages,
    stage_index: 0,
    stage_started_at: now,
    soak_minutes: settings.soakMinutes,
    status: 'active',
    halted_reason: null,
    admitted_host_ids: [],
    started_at: now,
    updated_at: now,
    history: live ? [...live.history] : [],
  };
  if (live) pushHistory(state, 'superseded', by, `${live.target_version} → ${target}`);
  state.admitted_host_ids = computeAdmitted(state, await loadRolloutHosts(db), 0);
  pushHistory(state, 'started', by, `${floor} → ${target} at ${stageLabel(state.stages[0])}`);
  await saveState(db, state);
  await logRollout(db, 'wrapper.rollout.started', state, { admitted: state.admitted_host_ids.length });
  publishState(state, true);
  return state;
}

export interface RolloutEvaluation {
  state: WrapperRolloutState | null;
  advanced: boolean;
  halted: boolean;
}

async function advance(db: Database, state: WrapperRolloutState, by: string, hosts?: RolloutHost[]): Promise<void> {
  state.stage_index += 1;
  state.stage_started_at = nowIso();
  if (state.stage_index >= state.stages.length) {
    state.status = 'complete';
    pushHistory(state, 'complete', by);
  } else {
    state.admitted_host_ids = computeAdmitted(state, hosts ?? (await loadRolloutHosts(db)), state.stage_index);
    pushHistory(state, 'advanced', by, stageLabel(state.stages[state.stage_index]));
  }
  await saveState(db, state);
  await logRollout(db, state.status === 'complete' ? 'wrapper.rollout.complete' : 'wrapper.rollout.advanced', state, {
    admitted: state.admitted_host_ids.length,
  });
  publishState(state, true);
}

/** Worker tick: halt on churn, otherwise advance a soaked stage that has a confirmed host. */
export async function evaluateRollout(
  db: Database,
  opts: { now?: number; registry?: CommunicatorRegistry } = {},
): Promise<RolloutEvaluation> {
  const state = await loadWrapperRollout(db, { fresh: true });
  if (!state || state.status !== 'active') return { state, advanced: false, halted: false };
  const registry = opts.registry ?? communicatorRegistry;
  const now = opts.now ?? Date.now();

  const churn = churningHosts(state, registry.tombstones(now));
  if (churn.length > 0) {
    state.status = 'halted';
    state.halted_reason = `communicator on ${state.target_version} restarted ${CHURN_HALT_THRESHOLD}+ times on host ${churn.join(', ')}`;
    pushHistory(state, 'halted', 'auto', state.halted_reason);
    await saveState(db, state);
    await logRollout(db, 'wrapper.rollout.halted', state, { reason: state.halted_reason, hosts: churn });
    publishState(state, false);
    return { state, advanced: false, halted: true };
  }

  const soakEnds = Date.parse(state.stage_started_at) + state.soak_minutes * 60_000;
  const hosts = await loadRolloutHosts(db);
  const stageHasHosts = state.admitted_host_ids.some((id) => hosts.some((h) => h.id === id && !h.excluded));
  if (stageHasHosts) {
    if (now < soakEnds) return { state, advanced: false, halted: false };
    const live = [...registry.views.values()].map((v) => ({ host_id: v.host_id, version: v.version }));
    if (confirmedHostIds(state, hosts, live).length === 0) return { state, advanced: false, halted: false };
  }
  await advance(db, state, 'auto', hosts);
  return { state, advanced: true, halted: false };
}

export class RolloutConflictError extends Error {}

async function requireLive(db: Database): Promise<WrapperRolloutState> {
  const state = await loadWrapperRollout(db, { fresh: true });
  if (!state || (state.status !== 'active' && state.status !== 'halted')) {
    throw new RolloutConflictError('no cxx rollout is in progress');
  }
  return state;
}

export async function haltRollout(db: Database, by: string, reason?: string): Promise<WrapperRolloutState> {
  const state = await requireLive(db);
  if (state.status === 'halted') return state;
  state.status = 'halted';
  state.halted_reason = reason?.trim() || `halted by ${by}`;
  pushHistory(state, 'halted', by, state.halted_reason);
  await saveState(db, state);
  await logRollout(db, 'wrapper.rollout.halted', state, { reason: state.halted_reason, by });
  publishState(state, false);
  return state;
}

/** Resuming restarts the current stage's soak, so the waves after it still get their full window. */
export async function resumeRollout(db: Database, by: string): Promise<WrapperRolloutState> {
  const state = await requireLive(db);
  if (state.status === 'active') return state;
  state.status = 'active';
  state.halted_reason = null;
  state.stage_started_at = nowIso();
  pushHistory(state, 'resumed', by);
  await saveState(db, state);
  await logRollout(db, 'wrapper.rollout.resumed', state, { by });
  publishState(state, false);
  return state;
}

/** Skip the rest of the current soak and move to the next stage now. */
export async function promoteRollout(db: Database, by: string): Promise<WrapperRolloutState> {
  const state = await requireLive(db);
  if (state.status === 'halted') {
    state.status = 'active';
    state.halted_reason = null;
  }
  await advance(db, state, by);
  return state;
}

/** Release the target to every host now. */
export async function completeRollout(db: Database, by: string): Promise<WrapperRolloutState> {
  const state = await requireLive(db);
  state.status = 'complete';
  state.halted_reason = null;
  state.stage_index = state.stages.length;
  state.stage_started_at = nowIso();
  pushHistory(state, 'complete', by, 'released to every host');
  await saveState(db, state);
  await logRollout(db, 'wrapper.rollout.complete', state, { by });
  publishState(state, true);
  return state;
}

/** Canary hosts join a running rollout immediately. */
export async function setHostWrapperCanary(db: Database, hostId: number, enabled: boolean, by: string): Promise<boolean> {
  const result = await db
    .update(hostsTable)
    .set({ wrapperCanary: enabled ? 1 : 0, updatedAt: nowIso() })
    .where(eq(hostsTable.id, hostId));
  const affected = (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
  if (affected === 0) return false;
  const state = await loadWrapperRollout(db, { fresh: true });
  if (enabled && state && (state.status === 'active' || state.status === 'halted') && !state.admitted_host_ids.includes(hostId)) {
    state.admitted_host_ids = computeAdmitted(state, await loadRolloutHosts(db), state.stage_index);
    pushHistory(state, 'canary_added', by, `host ${hostId}`);
    await saveState(db, state);
    publishState(state, true);
  }
  wsPublisher.publish('host.updated', { id: hostId, source: 'wrapper_canary' });
  return true;
}

export interface RolloutStatusView {
  enabled: boolean;
  settings: { stages: string[]; soak_minutes: number };
  rollout: (WrapperRolloutState & {
    stage: string;
    next_stage: string | null;
    soak_ends_at: string | null;
    confirmed_host_ids: number[];
  }) | null;
  hosts: Array<{ id: number; canary: boolean; excluded: boolean; running: string | null; admitted: boolean }>;
}

export async function rolloutStatus(db: Database, settings: RolloutSettings): Promise<RolloutStatusView> {
  const state = await loadWrapperRollout(db, { fresh: true });
  const hosts = await loadRolloutHosts(db);
  const admitted = new Set(state?.admitted_host_ids ?? []);
  const live = [...communicatorRegistry.views.values()].map((v) => ({ host_id: v.host_id, version: v.version }));
  return {
    enabled: settings.enabled,
    settings: { stages: settings.stages.map(stageLabel), soak_minutes: settings.soakMinutes },
    rollout: state
      ? {
          ...state,
          stage: stageLabel(state.stages[state.stage_index]),
          next_stage: state.stage_index + 1 < state.stages.length ? stageLabel(state.stages[state.stage_index + 1]) : null,
          soak_ends_at:
            state.status === 'active'
              ? new Date(Date.parse(state.stage_started_at) + state.soak_minutes * 60_000).toISOString()
              : null,
          confirmed_host_ids: confirmedHostIds(state, hosts, live),
        }
      : null,
    hosts: hosts.map((h) => ({ ...h, admitted: admitted.has(h.id) })),
  };
}
