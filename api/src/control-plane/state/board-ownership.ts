import type { OwnerRuntime } from './runtime.js';
import { mutateOwnerState } from './runtime.js';
import { ownerPresence } from '../presence.js';
import { stageUpdate } from './rows.js';
/** Transport loss preserves card exclusion; lifecycle ended is not process exit. */
export function trackBoardOwnership(owner: OwnerRuntime): () => void {
  const presence = ownerPresence(owner);
  let pending = false,
    closed = false;
  const reconcile = () => {
    if (pending || closed) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (closed) return;
      const missing = owner.state
        .snapshot()
        .table('coordProjectCards')
        .all()
        .filter(
          (card) =>
            card.claimedAt &&
            !card.claimReleasedAt &&
            !card.claimUncertaintyReason &&
            (!card.claimSessionId ||
              card.claimBindingGeneration === null ||
              !card.claimNativeInstanceId ||
              !presence
                .session(card.claimSessionId, card.claimBindingGeneration, 'session')
                .some((a) => a.scope.native_instance_id === card.claimNativeInstanceId)),
        );
      if (!missing.length) return;
      void mutateOwnerState(owner, {
        kind: 'project.board.ownership_uncertain',
        payload: { cards: missing.map((c) => c.id) },
        prepare: (ctx) => {
          for (const candidate of missing) {
            const card = ctx.draft.table('coordProjectCards').get(candidate.id);
            if (!card?.claimedAt || card.claimReleasedAt || card.claimUncertaintyReason) continue;
            if (
              card.claimSessionId &&
              card.claimBindingGeneration !== null &&
              card.claimNativeInstanceId &&
              presence
                .session(card.claimSessionId, card.claimBindingGeneration, 'session')
                .some((a) => a.scope.native_instance_id === card.claimNativeInstanceId)
            )
              continue;
            stageUpdate(ctx, 'coordProjectCards', card.id, {
              claimUncertaintyReason:
                card.claimOwnershipMode === 'connection' ? 'connection_lost' : 'legacy_owner_unproven',
            });
          }
          return null;
        },
      }).catch(() => {
        /* Owner command failures are handled by the executor; never release the claim. */
      });
    });
  };
  const unsub = presence.subscribe(reconcile);
  reconcile();
  return () => {
    closed = true;
    unsub();
  };
}
