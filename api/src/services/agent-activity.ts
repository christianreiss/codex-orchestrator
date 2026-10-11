import { z } from 'zod';
import { ConflictError } from '../http/errors.js';
import { receiverState, RECEIVER_FRESH_MS } from './agent-receiver-state.js';

export const ACTIVITY_FRESH_MS = 45_000;
export const activityInputSchema = z
  .object({
    generation: z.string().uuid(),
    binding_generation: z.number().int().nonnegative(),
    native_session_id: z.string().min(1).max(255),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(['working', 'idle', 'waiting', 'unknown']),
    wait_reason: z.enum(['approval', 'input']).nullable(),
    source: z.enum(['codex-thread', 'grok-session', 'claude-hooks']),
    evidence_age_ms: z.number().int().nonnegative().max(86_400_000),
  })
  .strict()
  .refine(
    (v) => (v.state === 'waiting' ? v.wait_reason !== null : v.wait_reason === null),
    'Only waiting activity has a wait reason',
  );
export type ActivityInput = z.infer<typeof activityInputSchema>;
export type ActivityRecord = ActivityInput & { received_at: string; expires_at: string; changed_at: string };
type Session = {
  activity?: unknown;
  receiver?: unknown;
  engine: string;
  upstreamSessionId: string | null;
  bindingGeneration: number;
  endedAt: string | null;
};

function record(raw: unknown): ActivityRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as ActivityRecord;
  return typeof value.sequence === 'number' && typeof value.expires_at === 'string' ? value : null;
}

/** Pure reducer; callers hold the session row lock. Duplicate receipts never extend expiry. */
export function acceptActivity(
  session: Session,
  input: ActivityInput,
  now = Date.now(),
): ActivityRecord | null {
  const receiver = receiverState(session.receiver);
  const source = { codex: 'codex-thread', claude: 'claude-hooks', grok: 'grok-session' }[session.engine];
  if (
    session.endedAt ||
    input.source !== source ||
    input.native_session_id !== session.upstreamSessionId ||
    input.binding_generation !== session.bindingGeneration ||
    receiver?.generation !== input.generation ||
    receiver.native_session_id !== input.native_session_id ||
    receiver.failure ||
    !(Date.parse(receiver.heartbeat_at) <= now && Date.parse(receiver.heartbeat_at) > now - RECEIVER_FRESH_MS)
  ) {
    throw new ConflictError(
      'Activity observer no longer owns this session',
      'agent_activity_binding_changed',
    );
  }
  const previous = record(session.activity);
  if (previous?.generation === input.generation && previous.sequence >= input.sequence) return null;
  const received = new Date(now).toISOString();
  const same =
    previous?.generation === input.generation &&
    previous.binding_generation === input.binding_generation &&
    previous.native_session_id === input.native_session_id &&
    previous.state === input.state &&
    previous.wait_reason === input.wait_reason &&
    Date.parse(previous.expires_at) > now;
  return {
    ...input,
    received_at: received,
    expires_at: new Date(now + ACTIVITY_FRESH_MS - input.evidence_age_ms).toISOString(),
    changed_at: same ? previous.changed_at : received,
  };
}

export function activityView(session: Session, now = Date.now(), question = false) {
  const value = record(session.activity);
  const receiver = receiverState(session.receiver);
  const valid =
    value &&
    !session.endedAt &&
    value.generation === receiver?.generation &&
    !receiver.failure &&
    value.native_session_id === session.upstreamSessionId &&
    value.binding_generation === session.bindingGeneration &&
    Date.parse(receiver.heartbeat_at) <= now &&
    Date.parse(receiver.heartbeat_at) > now - RECEIVER_FRESH_MS &&
    Date.parse(value.received_at) <= now &&
    Date.parse(value.expires_at) > now;
  const state = valid ? value.state : 'unknown';
  const portalWait = !session.endedAt && question && (state === 'idle' || state === 'unknown');
  return {
    state: portalWait ? 'waiting' : state,
    wait_reason: portalWait ? 'input' : valid ? value.wait_reason : null,
    source: portalWait ? 'portal-question' : (value?.source ?? null),
    changed_at: value?.changed_at ?? null,
    expires_at: portalWait ? null : (value?.expires_at ?? null),
    reason:
      portalWait || (valid && state !== 'unknown') ? null : value ? 'expired_or_unavailable' : 'unsupported',
  };
}
