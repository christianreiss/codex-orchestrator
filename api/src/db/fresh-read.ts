import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from './client.js';

const fresh = new AsyncLocalStorage<boolean>();
const snapshots = new AsyncLocalStorage<Map<object, object>>();

/** Freshness proofs must not be made from a periodically reconciled read cache. */
export function authoritativeReads<T>(run: () => T): T {
  return fresh.run(true, run);
}

export function requiresAuthoritativeReads(): boolean {
  return fresh.getStore() === true;
}

/** Existing services borrow the request's transaction without changing their APIs. */
export function scopedDatabase<T extends object>(db: T): T {
  const proxy = new Proxy(db, {
    get(target, property) {
      const source = snapshots.getStore()?.get(proxy) ?? target;
      const value = Reflect.get(source, property);
      return typeof value === 'function' ? value.bind(source) : value;
    },
  });
  return proxy;
}

export async function authoritativeSnapshot<T>(db: Database, run: () => Promise<T>): Promise<T> {
  return authoritativeReads(() =>
    db.transaction(
      async (tx) => {
        const bindings = new Map(snapshots.getStore());
        bindings.set(db, tx);
        // Fastify inject returns a lazy thenable. Assimilate it inside this context,
        // otherwise its request starts only after AsyncLocalStorage.run has exited.
        return snapshots.run(bindings, async () => await run());
      },
      { isolationLevel: 'repeatable read', withConsistentSnapshot: true },
    ),
  );
}
