import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from './client.js';

const fresh = new AsyncLocalStorage<boolean>();
const snapshots = new AsyncLocalStorage<Map<object, object>>();
const ownerReadHandles = new WeakSet<object>();
const rawHandles = new WeakMap<object, object>();
const ownerForbidden = new Set<PropertyKey>([
  'insert',
  'update',
  'delete',
  'transaction',
  'execute',
  '$client',
  'session',
]);

/** After hydration the public pool handle is for cold reads only. Domain writes
 * must use the separate transaction supplied by the exclusive owner. */
export function protectOwnerReadHandle(handle: object): void {
  if (rawHandles.has(handle)) ownerReadHandles.add(handle);
}

/** Explicit reviewed raw SELECT surface for content search/analytics. This does
 * not interpret SQL or project rows into state; current metadata uses the owner. */
export function executeColdRead(
  db: Database,
  query: Parameters<Database['execute']>[0],
): ReturnType<Database['execute']> {
  const raw = (snapshots.getStore()?.get(db) ?? rawHandles.get(db) ?? db) as Database;
  return raw.execute(query);
}

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
      const assertAllowed = () => {
        if (ownerReadHandles.has(proxy) && ownerForbidden.has(property))
          throw new Error(
            `Owner database boundary: ${String(property)} requires an owner transaction or explicit cold read`,
          );
      };
      assertAllowed();
      const value = Reflect.get(source, property);
      return typeof value === 'function'
        ? (...args: unknown[]) => {
            assertAllowed();
            return value.apply(source, args);
          }
        : value;
    },
  });
  rawHandles.set(proxy, db);
  return proxy;
}

export async function authoritativeSnapshot<T>(db: Database, run: () => Promise<T>): Promise<T> {
  const protectedOwner = ownerReadHandles.has(db);
  // Current content is part of the exclusive owner's immutable RAM state.
  // Opening a SQL transaction around RAM reads manufactured SQL on every
  // bootstrap/cache miss. Response authority is checked by the owner at send.
  if (protectedOwner) return authoritativeReads(async () => await run());
  // Only this reviewed read-only entrypoint borrows the underlying pool. The
  // public proxy remains protected throughout the callback, including raw SQL.
  const source = (protectedOwner ? rawHandles.get(db)! : db) as Database;
  return authoritativeReads(() =>
    source.transaction(
      async (tx) => {
        const bindings = new Map(snapshots.getStore());
        bindings.set(db, tx);
        // Fastify inject returns a lazy thenable. Assimilate it inside this context,
        // otherwise its request starts only after AsyncLocalStorage.run has exited.
        return snapshots.run(bindings, async () => await run());
      },
      // Drizzle cannot combine WITH CONSISTENT SNAPSHOT and READ ONLY (it
      // omits MySQL's required comma). Repeatable-read establishes the same
      // stable content snapshot on its first SELECT.
      {
        isolationLevel: 'repeatable read',
        ...(protectedOwner ? { accessMode: 'read only' as const } : { withConsistentSnapshot: true }),
      },
    ),
  );
}
