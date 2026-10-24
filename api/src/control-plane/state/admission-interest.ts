import type { OwnerRuntime } from './runtime.js';

interface Interest {
  lastAt: Map<number, number>;
  listeners: Set<() => void>;
}
const interests = new WeakMap<OwnerRuntime, Interest>();
function registry(owner: OwnerRuntime): Interest {
  let state = interests.get(owner);
  if (!state) {
    state = { lastAt: new Map(), listeners: new Set() };
    interests.set(owner, state);
    const owned = state;
    owner.state.subscribe(() => {
      const requests = owner.state.snapshot().table('insecureAuthRequests');
      for (const id of owned.lastAt.keys())
        if (requests.get(id)?.status !== 'pending') owned.lastAt.delete(id);
    });
  }
  return state;
}
/** Volatile waiter activity is not an authorization grant and never survives restart. */
export function admissionInterestAt(owner: OwnerRuntime, requestId: number): number | undefined {
  return interests.get(owner)?.lastAt.get(requestId);
}
export function observeAdmissionInterest(owner: OwnerRuntime, requestId: number, at = Date.now()): boolean {
  owner.assertOwner();
  const state = registry(owner);
  const first = !state.lastAt.has(requestId);
  state.lastAt.set(requestId, Math.max(state.lastAt.get(requestId) ?? 0, at));
  for (const listener of state.listeners) listener();
  return first;
}
export function subscribeAdmissionInterest(owner: OwnerRuntime, listener: () => void): () => void {
  const state = registry(owner);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}
export function pendingWithInterest<T extends { id: number; updatedAt: string }>(
  owner: OwnerRuntime,
  request: T,
): T {
  const at = admissionInterestAt(owner, request.id);
  return at === undefined
    ? request
    : { ...request, updatedAt: new Date(Math.max(at, Date.parse(request.updatedAt) || 0)).toISOString() };
}
