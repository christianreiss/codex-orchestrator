import { z } from 'zod';
import { ownerPresence } from '../presence.js';
import type { OwnerRuntime } from './runtime.js';
import type { OwnerStateSnapshot } from './store.js';
import type { StateRow } from './catalog.js';
import { receiverState } from '../../services/agent-receiver-state.js';
import { ConflictError } from '../../http/errors.js';

export const receiverTurnProofSchema = z
  .object({
    epoch: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(['idle', 'active', 'unknown']),
    native_instance_id: z.string().uuid(),
    binding_generation: z.number().int().positive(),
  })
  .strict();
export type ReceiverTurnProof = z.infer<typeof receiverTurnProofSchema>;
type StoredProof = ReceiverTurnProof & { attachment_id: string; receiver_generation: string };
type Session = Readonly<StateRow<'agentSessions'>>;

function stored(session: Session): StoredProof | undefined {
  return (session.activity as { turn_proof?: StoredProof } | null)?.turn_proof;
}
function attachment(owner: OwnerRuntime, session: Session, instance: string) {
  return ownerPresence(owner)
    .session(session.id, session.bindingGeneration, 'session')
    .find((value) => value.scope.native_instance_id === instance);
}

/** Separate from activity freshness: only exact live attachment and ordered
 * native lifecycle evidence authorize an idle boundary. Never a SQL lookup. */
export function acceptOwnedClaudeTurnProof(
  owner: OwnerRuntime,
  session: Session,
  proof?: ReceiverTurnProof,
): StoredProof | undefined {
  if (!proof) return undefined;
  const receiver = receiverState(session.receiver);
  const live = attachment(owner, session, proof.native_instance_id);
  if (
    session.engine !== 'claude' ||
    session.endedAt ||
    proof.binding_generation !== session.bindingGeneration ||
    !receiver ||
    receiver.failure ||
    !live ||
    receiver.native_session_id !== session.upstreamSessionId ||
    !ownerPresence(owner).hasReceiver(session.id, session.bindingGeneration, receiver.generation)
  )
    throw new ConflictError('Native turn proof binding changed', 'receiver_turn_proof_binding_changed');
  const previous = stored(session);
  const same =
    previous?.epoch === proof.epoch &&
    previous.attachment_id === live.id &&
    previous.receiver_generation === receiver.generation &&
    previous.native_instance_id === proof.native_instance_id;
  // Epochs start unknown. An idle report cannot re-anchor cached evidence after
  // reconnect/reset, nor can an old event reverse a newer active/unknown state.
  const bootstrap = proof.state === 'unknown';
  let state = proof.state;
  if (!same && !bootstrap) state = 'unknown';
  if (
    same &&
    proof.sequence <= previous.sequence &&
    (proof.sequence !== previous.sequence || proof.state !== previous.state)
  )
    state = 'unknown';
  return {
    ...proof,
    state,
    sequence: same ? Math.max(previous.sequence, proof.sequence) : proof.sequence,
    attachment_id: live.id,
    receiver_generation: receiver.generation,
  };
}

export function ownedClaudeTurnIdle(
  owner: OwnerRuntime,
  _snapshot: OwnerStateSnapshot,
  session: Session,
): boolean {
  const proof = stored(session),
    receiver = receiverState(session.receiver);
  if (
    !proof ||
    proof.state !== 'idle' ||
    session.engine !== 'claude' ||
    session.endedAt ||
    proof.binding_generation !== session.bindingGeneration ||
    !receiver ||
    receiver.failure ||
    proof.receiver_generation !== receiver.generation ||
    receiver.native_session_id !== session.upstreamSessionId ||
    !ownerPresence(owner).hasReceiver(session.id, session.bindingGeneration, receiver.generation)
  )
    return false;
  return attachment(owner, session, proof.native_instance_id)?.id === proof.attachment_id;
}
