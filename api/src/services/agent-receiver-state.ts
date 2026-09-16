import { randomUUID } from 'node:crypto';

export type ReceiverSource = 'peer' | 'portal';
export interface ReceiverProbe {
  id: string;
  nonce: string;
  created_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
  latency_ms: number | null;
}
export interface ReceiverState {
  generation: string;
  protocol: 'codex-queue-v1' | 'claude-channel-v1';
  native_session_id: string;
  heartbeat_at: string;
  failure: string | null;
  portal_closed?: boolean;
  probes: Partial<Record<ReceiverSource, ReceiverProbe>>;
}
export const RECEIVER_FRESH_MS = 45_000;
export const RECEIVER_PROBE_MS = 120_000;

export function receiverState(raw: unknown): ReceiverState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as ReceiverState;
  return typeof s.generation === 'string' && s.probes && typeof s.heartbeat_at === 'string' ? s : null;
}

export function newReceiverProbe(now: string): ReceiverProbe {
  return {
    id: randomUUID(),
    nonce: randomUUID(),
    created_at: now,
    delivered_at: null,
    acknowledged_at: null,
    latency_ms: null,
  };
}

export function receiverReady(raw: unknown, source: ReceiverSource, now = Date.now()): boolean {
  const s = receiverState(raw);
  const beat = Date.parse(s?.heartbeat_at ?? '');
  return Boolean(
    s &&
    !s.failure &&
    !(source === 'portal' && s.portal_closed) &&
    beat <= now &&
    beat > now - RECEIVER_FRESH_MS &&
    s.probes[source]?.acknowledged_at,
  );
}

/** Public evidence deliberately omits the challenge nonce. */
export function receiverView(raw: unknown, now = Date.now()) {
  const s = receiverState(raw);
  if (!s) return null;
  const fresh = Date.parse(s.heartbeat_at) <= now && Date.parse(s.heartbeat_at) > now - RECEIVER_FRESH_MS;
  const sources = Object.entries(s.probes).map(([source, p]) => ({
    source,
    delivery_id: p.id,
    delivered_at: p.delivered_at,
    acknowledged_at: p.acknowledged_at,
    latency_ms: p.latency_ms,
    state: s.failure
      ? 'failed'
      : !fresh
        ? 'unavailable'
        : p.acknowledged_at
          ? 'ready'
          : p.delivered_at && now - Date.parse(p.delivered_at) >= RECEIVER_PROBE_MS
            ? 'failed'
            : 'verifying',
  }));
  return {
    generation: s.generation,
    protocol: s.protocol,
    native_session_id: s.native_session_id,
    heartbeat_at: s.heartbeat_at,
    failure: s.failure,
    sources,
    state: s.failure
      ? 'failed'
      : !fresh
        ? 'unavailable'
        : sources.some((p) => p.state === 'failed')
          ? 'failed'
          : sources.length && sources.every((p) => p.state === 'ready')
            ? 'ready'
            : 'verifying',
  };
}
