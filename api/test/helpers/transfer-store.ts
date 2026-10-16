import type { Database } from '../../src/db/client.js';
import type { SettingsService } from '../../src/services/settings.js';
import { agentTransfers, agentTransferEvents } from '../../src/db/schema.js';
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const child of node) paramsOf(child, out);
    return out;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('queryChunks' in obj) paramsOf(obj['queryChunks'], out);
    else if ('value' in obj) out.push(obj['value']);
  }
  return out;
}

type Row = Record<string, unknown>;

export function createTransferDb(): Database & { rows: Map<unknown, Row[]> } {
  const rows = new Map<unknown, Row[]>([
    [agentTransfers, []],
    [agentTransferEvents, []],
  ]);
  const get = (table: unknown): Row[] => {
    if (!rows.has(table)) rows.set(table, []);
    return rows.get(table)!;
  };
  const locks = new Map<unknown, Promise<void>>();

  const db = {
    rows,
    select(releases?: Array<() => void>) {
      return {
        from(table: unknown) {
          const result: Row[] = get(table).map((row) => ({ ...row }));
          const chain = {
            where: (predicate: unknown) => {
              const ids = new Set(paramsOf(predicate));
              const filtered = result.filter(
                (row) => ids.has(row['id']) || ids.has(row['name']) || ids.has(row['engine']),
              );
              return Object.assign(Promise.resolve(filtered), {
                limit: () => Promise.resolve(filtered),
                orderBy: () =>
                  Object.assign(Promise.resolve(filtered), { limit: () => Promise.resolve(filtered) }),
                for: async () => {
                  if (!releases) throw new Error('Row locks require a transaction');
                  for (const id of ids) {
                    const previous = locks.get(id) ?? Promise.resolve();
                    let release!: () => void;
                    locks.set(
                      id,
                      new Promise<void>((resolve) => {
                        release = resolve;
                      }),
                    );
                    await previous;
                    releases.push(release);
                  }
                  // A locking read sees the row after its preceding writer
                  // commits, rather than the snapshot at query construction.
                  return get(table)
                    .filter((row) => ids.has(row['id']) || ids.has(row['name']) || ids.has(row['engine']))
                    .map((row) => ({ ...row }));
                },
              });
            },
            orderBy: () => Object.assign(Promise.resolve(result), { limit: () => Promise.resolve(result) }),
            limit: () => Promise.resolve(result),
            then: (resolve: (value: Row[]) => unknown) => Promise.resolve(result).then(resolve),
          };
          return chain;
        },
      };
    },
    async transaction<T>(callback: (tx: Database) => Promise<T>): Promise<T> {
      const releases: Array<() => void> = [];
      try {
        return await callback({ ...db, select: () => db.select(releases) } as unknown as Database);
      } finally {
        for (const release of releases.reverse()) release();
      }
    },
    insert(table: unknown) {
      return {
        values: (value: Row | Row[]) => {
          get(table).push(...(Array.isArray(value) ? value : [value]));
          return Promise.resolve([{ affectedRows: 1 }]);
        },
      };
    },
    update(table: unknown) {
      return {
        set: (patch: Row) => ({
          where: (predicate: unknown) => {
            const ids = new Set(paramsOf(predicate));
            for (const row of get(table)) {
              if (ids.has(row['id']) || ids.has(row['name']) || ids.has(row['engine']))
                Object.assign(row, patch);
            }
            return Promise.resolve([{ affectedRows: 1 }]);
          },
        }),
      };
    },
    delete(table: unknown) {
      return {
        where: (predicate: unknown) => {
          const ids = new Set(paramsOf(predicate));
          rows.set(
            table,
            get(table).filter(
              (row) => !(ids.has(row['id']) || ids.has(row['name']) || ids.has(row['engine'])),
            ),
          );
          return Promise.resolve([{ affectedRows: 1 }]);
        },
      };
    },
  };
  return db as unknown as Database & { rows: Map<unknown, Row[]> };
}

/** A settings fake over a plain map, matching SettingsService's surface. */
export function createTransferSettings(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    getRaw: async (key: string) => store.get(key) ?? null,
    getWithMeta: async (key: string) => ({ value: store.get(key) ?? null, updatedAt: null }),
    getFlag: async (key: string, fallback = false) =>
      store.has(key) ? ['1', 'true', 'yes', 'on'].includes(String(store.get(key))) : fallback,
    getInt: async (key: string, fallback: number) => (store.has(key) ? Number(store.get(key)) : fallback),
    getString: async (key: string, fallback: string | null = null) => store.get(key) ?? fallback,
    set: async (key: string, value: string) => void store.set(key, value),
    setFlag: async (key: string, value: boolean) => void store.set(key, value ? '1' : '0'),
    setInt: async (key: string, value: number) => void store.set(key, String(value)),
    delete: async (key: string) => void store.delete(key),
    deleteIf: async () => true,
  } as unknown as SettingsService & { store: Map<string, string> };
}
