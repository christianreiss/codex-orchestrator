export type ReceiverSource = 'peer' | 'portal';
export const RECEIVER_CLAIM_GATES = ['unknown', 'open', 'held_delivery', 'work_active', 'portal_pending', 'thread_active', 'thread_waiting', 'thread_other'] as const;
export const RECEIVER_CLAIM_GATE_MAX_SECONDS = 604800;
export interface ReceiverClaimGate {
  state: typeof RECEIVER_CLAIM_GATES[number];
  seconds: number;
}
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
  protocol: 'codex-queue-v1' | 'claude-channel-v1' | 'grok-acp-v1';
  native_session_id: string;
  heartbeat_at: string;
  failure: string | null;
  portal_closed?: boolean;
  /** Negotiated once per connection; replaying registration preserves it. */
  activity_v1?: boolean;
  queue_delivery_v1?: boolean;
  peer_batch_v1?: boolean;
  claim_gate_v1?: boolean;
  claim_gate?: ReceiverClaimGate & { observed_at: string };
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
  const gate = s.claim_gate;
  const showGate = s.claim_gate_v1 === true && fresh && !s.failure && sources.length > 0 && gate &&
    RECEIVER_CLAIM_GATES.includes(gate.state) && Number.isInteger(gate.seconds) &&
    gate.seconds >= 0 && gate.seconds <= RECEIVER_CLAIM_GATE_MAX_SECONDS && gate.observed_at === s.heartbeat_at;
  return {
    generation: s.generation,
    protocol: s.protocol,
    native_session_id: s.native_session_id,
    heartbeat_at: s.heartbeat_at,
    failure: s.failure,
    queue_delivery_v1: s.queue_delivery_v1 === true,
    peer_batch_v1: s.peer_batch_v1 === true,
    claim_gate_v1: s.claim_gate_v1 === true,
    ...(showGate ? {
      claim_gate: gate.state,
      claim_gate_seconds: gate.seconds,
      claim_gate_observed_at: gate.observed_at,
      claim_gate_note: gate.state === 'open' ? 'No local claim gate at the last heartbeat; delivery is not confirmed.'
        : gate.state === 'unknown' ? 'The local claim gate has not been observed yet.'
        : gate.state === 'work_active' ? 'Only informational coordination can be claimed while accepted work remains active.'
        : gate.state.startsWith('thread_') ? 'The next delivery waits for the native thread to become idle.'
        : 'The next delivery waits for this session to finish its current delivery.',
    } : {}),
    sources,
    state: s.failure ? 'failed' : !fresh || !sources.length ? 'unavailable' : 'ready',
  };
}
