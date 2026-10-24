import type { OwnerRuntime } from '../../control-plane/state/runtime.js';
interface Observation {
  seenAt: number;
  visibleSessionId: string | null;
  visibleUntil: number;
  connections: number;
}
const stores = new WeakMap<OwnerRuntime, Map<string, Observation>>();
function store(owner: OwnerRuntime) {
  let value = stores.get(owner);
  if (!value) {
    value = new Map();
    stores.set(owner, value);
    owner.state.subscribe((snapshot) => {
      for (const id of value!.keys()) if (!snapshot.table('companionDevices').has(id)) value!.delete(id);
    });
  }
  return value;
}
export function observeCompanion(owner: OwnerRuntime, id: string, visibleSessionId?: string | null): void {
  owner.assertOwner();
  const values = store(owner),
    previous = values.get(id),
    now = Date.now();
  values.set(id, {
    seenAt: now,
    visibleSessionId:
      visibleSessionId === undefined ? (previous?.visibleSessionId ?? null) : visibleSessionId,
    visibleUntil:
      visibleSessionId === undefined ? (previous?.visibleUntil ?? 0) : visibleSessionId ? now + 45_000 : 0,
    connections: previous?.connections ?? 0,
  });
}
export function attachCompanion(owner: OwnerRuntime, id: string): () => void {
  observeCompanion(owner, id);
  const values = store(owner);
  values.get(id)!.connections++;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = values.get(id);
    if (current) {
      current.connections = Math.max(0, current.connections - 1);
      current.seenAt = Date.now();
    }
  };
}
export function companionVisible(owner: OwnerRuntime, id: string, sessionId: string): boolean {
  const value = store(owner).get(id);
  return (
    !!value &&
    value.visibleSessionId === sessionId &&
    (value.connections > 0 || value.visibleUntil > Date.now())
  );
}
export function companionLastSeen(owner: OwnerRuntime, id: string, durable: string): string {
  const value = store(owner).get(id);
  return value && value.seenAt > Date.parse(durable) ? new Date(value.seenAt).toISOString() : durable;
}
