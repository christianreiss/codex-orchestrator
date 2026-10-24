import type { OwnerRuntime } from './runtime.js';

/** Public sync artifacts only; credentials, messages and private project bodies
 * never enter this bounded pool. Keys include canonical identity and digest. */
const pools = new WeakMap<
  OwnerRuntime,
  { entries: Map<string, { value: unknown; bytes: number }>; bytes: number }
>();
export async function publicArtifact<T>(
  owner: OwnerRuntime,
  key: string,
  load: () => Promise<T>,
  stillCurrent: () => boolean,
): Promise<T> {
  owner.assertOwner();
  let pool = pools.get(owner);
  if (!pool) {
    pool = { entries: new Map(), bytes: 0 };
    pools.set(owner, pool);
  }
  const existing = pool.entries.get(key);
  if (existing) {
    if (!stillCurrent()) throw new Error('Canonical artifact changed during content read');
    pool.entries.delete(key);
    pool.entries.set(key, existing);
    return structuredClone(existing.value) as T;
  }
  const value = await load();
  owner.assertOwner();
  if (!stillCurrent())
    throw new Error('Canonical artifact changed during content read; retry against current metadata');
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes <= 16 * 1024 * 1024) {
    while (pool.entries.size >= 128 || pool.bytes + bytes > 16 * 1024 * 1024) {
      const first = pool.entries.entries().next().value;
      if (!first) break;
      pool.entries.delete(first[0]);
      pool.bytes -= first[1].bytes;
    }
    pool.entries.set(key, { value: structuredClone(value), bytes });
    pool.bytes += bytes;
  }
  return value;
}
