import { ownerPresence } from '../../control-plane/presence.js';
import type { OwnerRuntime } from '../../control-plane/state/runtime.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import type { ScopeSession } from '../../control-plane/state/coordination.js';
import { ConflictError } from '../../http/errors.js';

/** Diagnose only the authenticated caller; never disclose another claim's owner/proof. */
export function claimConnectionError(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  session: ScopeSession,
  message = 'A proven native connection is required for resource ownership',
  expectedNativeInstanceId?: string | null,
) {
  const attachments = ownerPresence(owner).session(session.id, session.bindingGeneration, 'session');
  const native = attachments.filter((attachment) => attachment.scope.native_instance_id);
  const original = expectedNativeInstanceId
    ? native.some((attachment) => attachment.scope.native_instance_id === expectedNativeInstanceId)
    : null;
  const alias = session.engine === 'claude' ? 'clx' : session.engine === 'grok' ? 'cgx' : 'cdx';
  return new ConflictError(
    `${message}. Run cxx communicator status and ${alias} doctor on this host; reconnect the original managed native process, then retry with the same request ID. Naming or context updates do not restore ownership proof.`,
    'claim_connection_required',
    {
      claim_connection: {
        session_id: session.id,
        binding_generation: session.bindingGeneration,
        host_id: session.hostId,
        fqdn: snapshot.hosts.get(session.hostId)?.fqdn ?? null,
        engine: session.engine,
        native_session_bound: Boolean(session.upstreamSessionId),
        proof_state: !attachments.length
          ? 'session_attachment_missing'
          : !native.length
            ? 'native_instance_missing'
            : original === false
              ? 'original_native_instance_missing'
              : 'native_connection_present',
        original_native_connection_present: original,
        recovery: {
          diagnostic_commands: ['cxx communicator status', `${alias} doctor`],
          action:
            'Inspect the communicator on this host. Reconnect the original managed native process; naming or context updates do not establish connection proof. Coordinate any stale shared-owner restart with its active users.',
          retry:
            'After proof is restored, retry acquire with the same client_request_id; for an existing claim use resource_claim_status with claim_id and renew:true.',
          uncertain_outcome:
            'Do not take over, clear, or revive an unknown operation. The proven original owner must confirm it ended, or an operator must resolve it with evidence.',
        },
      },
    },
  );
}
