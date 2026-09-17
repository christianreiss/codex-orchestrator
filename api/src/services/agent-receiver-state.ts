export type ReceiverSource = 'peer' | 'portal';
/** The legacy probes map now records source membership only. Old evidence is inert. */
export interface ReceiverSourceState {
  id?: string;
  nonce?: string;
  created_at?: string;
  delivered_at?: string | null;
  acknowledged_at?: string | null;
  latency_ms?: number | null;
}
export interface ReceiverState {
  generation: string;
  protocol: 'codex-queue-v1' | 'claude-channel-v1';
  native_session_id: string;
  heartbeat_at: string;
  failure: string | null;
  portal_closed?: boolean;
  probes: Partial<Record<ReceiverSource, ReceiverSourceState>>;
}
export const RECEIVER_FRESH_MS = 45_000;

export function receiverState(raw: unknown): ReceiverState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as ReceiverState;
  return typeof s.generation === 'string' && s.probes && typeof s.heartbeat_at === 'string' ? s : null;
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
    s.probes[source],
  );
}

/** Readiness is transport health, never a synthetic model acknowledgment. */
export function receiverView(raw: unknown, now = Date.now()) {
  const s = receiverState(raw);
  if (!s) return null;
  const fresh = Date.parse(s.heartbeat_at) <= now && Date.parse(s.heartbeat_at) > now - RECEIVER_FRESH_MS;
  const sources = Object.keys(s.probes)
    .filter((source) => !(source === 'portal' && s.portal_closed))
    .map((source) => ({
      source,
      // Compatibility fields for older dashboards; never fabricate model evidence.
      delivery_id: null,
      delivered_at: null,
      acknowledged_at: null,
      latency_ms: null,
      state: s.failure ? 'failed' : !fresh ? 'unavailable' : 'ready',
    }));
  return {
    generation: s.generation,
    protocol: s.protocol,
    native_session_id: s.native_session_id,
    heartbeat_at: s.heartbeat_at,
    failure: s.failure,
    sources,
    state: s.failure ? 'failed' : !fresh || !sources.length ? 'unavailable' : 'ready',
  };
}
