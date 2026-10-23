import { createHash } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';

/**
 * In-memory read cache for small, hot, rarely changed tables (hosts, versions,
 * host_daemons). It sits below Drizzle, on the mysql2 pool, so every caller is
 * covered without call-site changes.
 *
 * This is not a TTL cache. This API process writes these tables itself, so
 * invalidation happens synchronously, in the write path:
 * - a write statement invalidates when it is issued;
 * - a transactional write invalidates again at COMMIT, ROLLBACK or release,
 *   and while it is open, reads of that table bypass the cache;
 * - a load is stored only if no write touched its tables while it ran.
 *
 * Writes from other processes (manual SQL, CLI ops, migrations) are caught by
 * a resync every `resyncMs`: it hashes each row and invalidates exactly the
 * rows whose content changed, so this process's own frequent writes (contact
 * times, call counters) do not flush the whole table.
 *
 * Plain SELECTs are cached, including those inside transactions: for these
 * config tables a value newer than the transaction's snapshot only makes
 * revocation visible sooner, and a transaction holding its own uncommitted
 * write to a table bypasses the cache for that table. Locking reads and
 * non-deterministic SQL always go to MySQL.
 */

export interface ReadCacheTable {
  /** Unique columns: a single-row lookup on one survives writes to other rows. */
  uniqueColumns: string[];
  /** Column that `UPDATE ... WHERE t.<rowKey> = ?` names, for row-level invalidation. */
  rowKey?: string;
}

export interface ReadCacheOptions {
  tables: Record<string, ReadCacheTable>;
  /** Every table name in the schema; a statement naming any other table is never cached. */
  allTables: Iterable<string>;
  maxEntries?: number;
  resyncMs?: number;
}

export interface ReadCacheStats {
  hits: number;
  misses: number;
  bypasses: number;
  invalidations: number;
  resyncFlushes: number;
  entries: number;
}

interface Entry {
  result: [unknown, unknown];
  tables: string[];
  /** Row-key values per table, or null when the result does not expose the key column. */
  rowKeys: Map<string, Set<string> | null>;
  /** Tables this entry looks up by a unique column, with at most one row. */
  uniqueLookup: Set<string>;
  rowCount: number;
}

type Kind = 'read' | 'write' | 'begin' | 'commit' | 'rollback' | 'other';

const NON_DETERMINISTIC =
  /\b(now|current_timestamp|current_date|current_time|localtime|localtimestamp|utc_timestamp|utc_date|utc_time|sysdate|curdate|curtime|unix_timestamp|rand|uuid|uuid_short|last_insert_id|found_rows|row_count|connection_id|get_lock|release_lock|is_free_lock|is_used_lock|sleep|benchmark|database|user|current_user|session_user|system_user)\s*\(|\bcurrent_timestamp\b|@|\bfor\s+update\b|\bfor\s+share\b|\block\s+in\s+share\b|\binto\b|\bnowait\b|\bskip\s+locked\b/i;

function sqlText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && typeof (arg as { sql?: unknown }).sql === 'string') return (arg as { sql: string }).sql;
  return '';
}

function classify(sql: string): Kind {
  const head = /^[\s(]*([a-z]+)(?:\s+([a-z]+))?/i.exec(sql);
  const first = head?.[1]?.toLowerCase() ?? '';
  const second = head?.[2]?.toLowerCase() ?? '';
  switch (first) {
    case 'select':
      return 'read';
    case 'with':
      return /\b(update|delete|insert|replace)\b/i.test(sql) ? 'write' : 'read';
    case 'show':
    case 'explain':
    case 'describe':
    case 'desc':
    case 'checksum':
    case 'savepoint':
    case 'release':
      return 'other';
    case 'set':
      return 'other';
    case 'begin':
      return 'begin';
    case 'start':
      return second === 'transaction' ? 'begin' : 'write';
    case 'commit':
      return 'commit';
    case 'rollback':
      return second === 'to' ? 'other' : 'rollback';
    case 'xa':
    case 'lock':
    case 'unlock':
      return 'other';
    default:
      return 'write';
  }
}

export class ReadCache {
  private readonly tables: Map<string, ReadCacheTable>;
  private readonly known: Set<string>;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Entry>();
  /** Bumped by every write touching the table; a load stores only if unchanged. */
  private readonly writeSeq = new Map<string, number>();
  /** Writes issued but not yet committed or rolled back. */
  private readonly inFlight = new Map<string, number>();
  private readonly counters = { hits: 0, misses: 0, bypasses: 0, invalidations: 0, resyncFlushes: 0 };
  private rowHashes = new Map<string, Map<string, string>>();
  private raw: ((arg: unknown, values?: unknown) => Promise<unknown>) | undefined;
  private resyncTimer: NodeJS.Timeout | undefined;

  constructor(private readonly pool: Pool, options: ReadCacheOptions) {
    this.tables = new Map(Object.entries(options.tables));
    this.known = new Set([...options.allTables].map((t) => t.toLowerCase()));
    for (const t of this.tables.keys()) this.known.add(t);
    this.maxEntries = options.maxEntries ?? 4096;
    for (const t of this.tables.keys()) {
      this.writeSeq.set(t, 0);
      this.inFlight.set(t, 0);
    }
    this.install();
    if (options.resyncMs && options.resyncMs > 0) {
      this.resyncTimer = setInterval(() => void this.resync().catch(() => this.flushAll()), options.resyncMs);
      this.resyncTimer.unref();
    }
  }

  stats(): ReadCacheStats {
    return { ...this.counters, entries: this.entries.size };
  }

  close() {
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.resyncTimer = undefined;
    this.entries.clear();
  }

  flushAll() {
    for (const t of this.tables.keys()) this.invalidate(t, null);
  }

  /** Cacheable tables a statement names, plus whether it names any other table. */
  private tablesIn(sql: string): { cacheable: string[]; other: boolean } {
    const cacheable = new Set<string>();
    let other = false;
    for (const match of sql.matchAll(/`([^`]+)`|\b([a-z_][a-z0-9_]*)\b/gi)) {
      const word = (match[1] ?? match[2] ?? '').toLowerCase();
      if (!this.known.has(word)) continue;
      if (this.tables.has(word)) cacheable.add(word);
      else other = true;
    }
    return { cacheable: [...cacheable], other };
  }

  /** `update `t` set ... where `t`.`key` = ?` (Drizzle's shape): the key is the last bind value. */
  private rowTarget(sql: string, values: unknown, table: string): string | null {
    const key = this.tables.get(table)?.rowKey;
    if (!key || !Array.isArray(values) || values.length === 0) return null;
    const pattern = new RegExp(`^\\s*update\\s+\`${table}\`\\s+set\\s[\\s\\S]*\\swhere\\s+\`${table}\`\\s*\\.\\s*\`${key}\`\\s*=\\s*\\?\\s*$`, 'i');
    if (!pattern.test(sql)) return null;
    // A subquery could reach another row; the SET clause must stay flat.
    if (/\bselect\b/i.test(sql)) return null;
    const value = values[values.length - 1];
    return value === null || value === undefined ? null : String(value);
  }

  private invalidate(table: string, row: string | null) {
    this.writeSeq.set(table, (this.writeSeq.get(table) ?? 0) + 1);
    this.counters.invalidations++;
    for (const [key, entry] of this.entries) {
      if (!entry.tables.includes(table)) continue;
      if (row !== null && entry.uniqueLookup.has(table) && entry.rowCount === 1) {
        const keys = entry.rowKeys.get(table);
        if (keys && !keys.has(row)) continue;
      }
      this.entries.delete(key);
    }
  }

  private beginWrite(sql: string, values: unknown): Array<{ table: string; row: string | null }> {
    const { cacheable } = this.tablesIn(sql);
    // DDL or a statement we cannot attribute: drop everything.
    const targets = /^\s*(alter|create|drop|truncate|rename)\b/i.test(sql)
      ? [...this.tables.keys()].map((table) => ({ table, row: null }))
      : cacheable.map((table) => ({ table, row: this.rowTarget(sql, values, table) }));
    for (const { table, row } of targets) {
      this.inFlight.set(table, (this.inFlight.get(table) ?? 0) + 1);
      this.invalidate(table, row);
    }
    return targets;
  }

  private endWrite(targets: Array<{ table: string; row: string | null }>) {
    for (const { table, row } of targets) {
      this.invalidate(table, row);
      this.inFlight.set(table, Math.max(0, (this.inFlight.get(table) ?? 0) - 1));
    }
  }

  private cacheKey(arg: unknown, values: unknown, sql: string): string {
    const options = arg && typeof arg === 'object' ? (arg as Record<string, unknown>) : {};
    const bound = values ?? options.values;
    return JSON.stringify([sql, options.rowsAsArray === true, typeof options.typeCast === 'function', bound ?? null]);
  }

  private describe(result: [unknown, unknown], tables: string[], sql: string): Omit<Entry, 'result' | 'tables'> {
    const rows = Array.isArray(result[0]) ? (result[0] as unknown[]) : [];
    const fields = Array.isArray(result[1]) ? (result[1] as Array<{ orgTable?: string; table?: string; orgName?: string; name?: string }>) : [];
    const rowKeys = new Map<string, Set<string> | null>();
    const uniqueLookup = new Set<string>();
    for (const table of tables) {
      const config = this.tables.get(table)!;
      const key = config.rowKey;
      const index = key ? fields.findIndex((f) => (f.orgTable ?? f.table)?.toLowerCase() === table && (f.orgName ?? f.name) === key) : -1;
      if (index < 0) {
        rowKeys.set(table, null);
      } else {
        const name = fields[index]?.name ?? key!;
        rowKeys.set(table, new Set(rows.map((row) => String(Array.isArray(row) ? row[index] : (row as Record<string, unknown>)[name]))));
      }
      const unique = config.uniqueColumns.some((column) =>
        new RegExp(`\\bwhere\\s+\\(?\\s*\`${table}\`\\s*\\.\\s*\`${column}\`\\s*=\\s*\\?`, 'i').test(sql),
      );
      if (unique && rows.length <= 1) uniqueLookup.add(table);
    }
    return { rowKeys, uniqueLookup, rowCount: rows.length };
  }

  private async read(call: () => Promise<[unknown, unknown]>, arg: unknown, values: unknown, sql: string) {
    const { cacheable, other } = this.tablesIn(sql);
    if (other || cacheable.length === 0 || NON_DETERMINISTIC.test(sql)) return call();
    const key = this.cacheKey(arg, values, sql);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      this.counters.hits++;
      return [structuredClone(hit.result[0]), hit.result[1]] as [unknown, unknown];
    }
    if (cacheable.some((t) => (this.inFlight.get(t) ?? 0) > 0)) {
      this.counters.bypasses++;
      return call();
    }
    this.counters.misses++;
    const before = cacheable.map((t) => this.writeSeq.get(t));
    const result = await call();
    const clean = cacheable.every((t, i) => this.writeSeq.get(t) === before[i] && (this.inFlight.get(t) ?? 0) === 0);
    if (clean && Array.isArray(result)) {
      this.entries.set(key, { result: [structuredClone(result[0]), result[1]], tables: cacheable, ...this.describe(result, cacheable, sql) });
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    }
    return result;
  }

  private async write<T>(call: () => Promise<T>, sql: string, values: unknown): Promise<T> {
    const targets = this.beginWrite(sql, values);
    try {
      return await call();
    } finally {
      this.endWrite(targets);
    }
  }

  private install() {
    const pool = this.pool as unknown as Record<'query' | 'execute', (...args: unknown[]) => Promise<unknown>>;
    for (const method of ['query', 'execute'] as const) {
      const original = pool[method].bind(this.pool);
      if (method === 'query') this.raw = original;
      pool[method] = (arg: unknown, values?: unknown) => {
        const sql = sqlText(arg);
        const kind = classify(sql);
        const call = () => original(arg, values) as Promise<[unknown, unknown]>;
        if (kind === 'read') return this.read(call, arg, values, sql);
        if (kind === 'write' || kind === 'begin') return this.write(call, sql, values);
        return call();
      };
    }
    const getConnection = this.pool.getConnection.bind(this.pool);
    (this.pool as { getConnection: () => Promise<PoolConnection> }).getConnection = async () => {
      const connection = await getConnection();
      this.wrapConnection(connection);
      return connection;
    };
  }

  /** Writes on a checked-out connection stay pending until COMMIT, ROLLBACK or release. */
  private wrapConnection(connection: PoolConnection) {
    const target = connection as unknown as Record<'query' | 'execute' | 'release', (...args: unknown[]) => unknown>;
    let inTransaction = false;
    let pending: Array<{ table: string; row: string | null }> = [];
    const settle = () => {
      const done = pending;
      pending = [];
      this.endWrite(done);
    };
    for (const method of ['query', 'execute'] as const) {
      const original = target[method].bind(connection) as (...args: unknown[]) => Promise<unknown>;
      target[method] = async (arg: unknown, values?: unknown) => {
        const sql = sqlText(arg);
        const kind = classify(sql);
        if (kind === 'begin') {
          inTransaction = true;
          return original(arg, values);
        }
        if (kind === 'commit' || kind === 'rollback') {
          try {
            return await original(arg, values);
          } finally {
            inTransaction = false;
            settle();
          }
        }
        if (kind === 'read') return this.read(() => original(arg, values) as Promise<[unknown, unknown]>, arg, values, sql);
        if (kind !== 'write') return original(arg, values);
        if (!inTransaction) return this.write(() => original(arg, values), sql, values);
        pending.push(...this.beginWrite(sql, values));
        return original(arg, values);
      };
    }
    const release = target.release.bind(connection);
    target.release = () => {
      inTransaction = false;
      settle();
      return release();
    };
  }

  /**
   * Compares every row with the previous pass. A changed row is invalidated on
   * its own; an added or removed row, or a table without a row key, flushes the
   * table. Reads bypass the cache so the pass always sees MySQL.
   */
  private async resync() {
    const raw = this.raw;
    if (!raw) return;
    for (const [name, config] of this.tables) {
      const key = config.rowKey;
      const [rows, fields] = (await raw({ sql: `SELECT * FROM \`${name}\`` })) as [unknown[], Array<{ name?: string }> | undefined];
      const index = key && fields ? fields.findIndex((f) => f.name === key) : -1;
      const next = new Map<string, string>();
      for (const row of rows) {
        const id = Array.isArray(row) ? row[index] : key ? (row as Record<string, unknown>)[key] : undefined;
        next.set(String(id ?? next.size), createHash('sha1').update(JSON.stringify(row)).digest('base64'));
      }
      const previous = this.rowHashes.get(name);
      this.rowHashes.set(name, next);
      if (!previous) continue;
      const reshaped = !key || previous.size !== next.size || [...next.keys()].some((id) => !previous.has(id));
      if (reshaped) {
        this.counters.resyncFlushes++;
        this.invalidate(name, null);
        continue;
      }
      for (const [id, hash] of next) {
        if (previous.get(id) === hash) continue;
        this.counters.resyncFlushes++;
        this.invalidate(name, id);
      }
    }
  }
}

export function installReadCache(pool: Pool, options: ReadCacheOptions): ReadCache {
  return new ReadCache(pool, options);
}
