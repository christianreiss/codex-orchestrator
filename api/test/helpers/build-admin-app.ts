/**
 * Builds a Fastify instance with the Phase-2.2 routes wired against an
 * in-memory store. Rather than re-implementing Drizzle's SQL builder, we hand
 * the services a Proxy that records every method call and resolves them via
 * a tiny test-only query dispatcher. Each test scenario installs the
 * responses it needs via `store` helpers.
 *
 * The integration suite covers the route + service plumbing that matters for
 * Phase 2.2: login (with rehash), session lookup, logout, password change,
 * user CRUD validation. Anywhere the test plumbing diverges from Drizzle's
 * real behaviour, the unit suite picks up the slack.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../src/http/plugins/request-id.js';
import { ForbiddenError, UnauthorizedError } from '../../src/http/errors.js';
import type { AdminContext } from '../../src/http/plugins/auth-admin.js';
import type { Env } from '../../src/env.js';
import type { AdminPasskey, AdminSession, AdminUser } from '../../src/db/schema.js';
import { registerAdminAuthAndUsersRoutes } from '../../src/routes/admin-auth-users/index.js';
import { sha256 } from '../../src/security/hash.js';
import { getTableName } from 'drizzle-orm';

export interface AdminStore {
  users: AdminUser[];
  sessions: AdminSession[];
  passwordResets: Array<{
    id: number;
    userId: number;
    tokenHash: string;
    expiresAt: string;
    usedAt: string | null;
    createdAt: string;
  }>;
  passkeys: AdminPasskey[];
  challenges: Array<{
    id: number;
    challenge: string;
    userId: number | null;
    type: string;
    expiresAt: string;
    createdAt: string;
  }>;
  events: Array<{
    id: number;
    type: string;
    hostId: number | null;
    payload: unknown;
    createdAt: string;
  }>;
  nextId: number;
}

function emptyStore(): AdminStore {
  return {
    users: [],
    sessions: [],
    passwordResets: [],
    passkeys: [],
    challenges: [],
    events: [],
    nextId: 1,
  };
}

const TEST_ENV: Env = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  LISTEN_HOST: '127.0.0.1',
  LISTEN_PORT: 0,
  LOG_LEVEL: 'silent',
  LOG_PRETTY: false,
  STATIC_ROOT: '',
  DB_HOST: 'localhost',
  DB_PORT: 3306,
  DB_DATABASE: 'test',
  DB_USERNAME: 'test',
  DB_PASSWORD: 'test',
  DB_CHARSET: 'utf8mb4',
  DB_POOL_SIZE: 1,
  ADMIN_ACCESS_MODE: 'cookie',
  ADMIN_SESSION_COOKIE: 'codex_admin_session',
  ADMIN_SESSION_TTL_MINUTES: 60,
  ADMIN_WS_ENABLED: false,
  ADMIN_WS_HEARTBEAT_SECONDS: 30,
  ADMIN_WS_BACKLOG_LIMIT: 200,
  ADMIN_WEBAUTHN_RP_NAME: 'Codex Orchestrator',
  PUBLIC_BASE_URL_REQUIRED: false,
  TRUST_X_FORWARDED: false,
  TRUSTED_PROXY_CIDRS: '',
  STRICT_HOST_VALIDATION: true,
  MCP_ALLOW_REQUEST_HOST_ORIGIN: false,
  INSECURE_GRACE_MINUTES: 60,
  RUN_MIGRATIONS_ON_BOOT: false,
  RUN_BACKFILLS_ON_BOOT: false,
  DEFAULT_HOST_ENGINES: 'codex',
  PRICING_CURRENCY: 'USD',
  CHATGPT_USAGE_CRON_INTERVAL: 3600,
  SMTP_SECURE: false,
  AUTH_RUNNER_TIMEOUT: 8,
  AUTH_RUNNER_IP_BYPASS: false,
  AUTH_RUNNER_BYPASS_SUBNETS: '',
  AUTH_RUNNER_PREFLIGHT_SECONDS: 28800,
  AUTH_SEED_TOKEN_TTL_SECONDS: 900,
} as unknown as Env;

// ─────────────────────────────────────────────────────────────────────────
// Drizzle stand-in
// ─────────────────────────────────────────────────────────────────────────
//
// The fake-db here is a single big switch on the call shape (the chain of
// methods invoked on `db`). Tests pre-populate the store; the services walk
// it via the chains below. Anything not modelled here returns an empty array
// or a no-op affected-rows record.

interface CallNode {
  method: string;
  args: unknown[];
  next?: CallNode;
}

function buildChain(method: string, args: unknown[], onResolve: (chain: CallNode) => unknown): unknown {
  const root: CallNode = { method, args };
  let tail = root;
  const builder: Record<string, unknown> = {};
  builder.from = (...a: unknown[]) => {
    tail.next = { method: 'from', args: a };
    tail = tail.next;
    return builder;
  };
  builder.where = (...a: unknown[]) => {
    tail.next = { method: 'where', args: a };
    tail = tail.next;
    return builder;
  };
  builder.orderBy = (...a: unknown[]) => {
    tail.next = { method: 'orderBy', args: a };
    tail = tail.next;
    return builder;
  };
  builder.limit = (...a: unknown[]) => {
    tail.next = { method: 'limit', args: a };
    tail = tail.next;
    return builder;
  };
  builder.set = (...a: unknown[]) => {
    tail.next = { method: 'set', args: a };
    tail = tail.next;
    return builder;
  };
  builder.values = (...a: unknown[]) => {
    tail.next = { method: 'values', args: a };
    tail = tail.next;
    return Promise.resolve(onResolve(root));
  };
  builder.innerJoin = (...a: unknown[]) => {
    tail.next = { method: 'innerJoin', args: a };
    tail = tail.next;
    return builder;
  };
  builder.then = (onFulfilled: unknown, onRejected?: unknown) =>
    Promise.resolve(onResolve(root)).then(
      onFulfilled as (v: unknown) => unknown,
      onRejected as ((e: unknown) => unknown) | undefined,
    );
  builder.catch = (onRejected: unknown) => Promise.resolve(onResolve(root)).catch(onRejected as (e: unknown) => unknown);
  return builder;
}

interface DriverContext {
  resolveTable: (raw: unknown) => keyof AdminStore | null;
  evalWhere: (chain: CallNode | undefined, row: Record<string, unknown>, table: keyof AdminStore) => boolean;
  evalJoin: (
    chain: CallNode | undefined,
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    aTable: keyof AdminStore,
    bTable: keyof AdminStore,
  ) => boolean;
}

const TABLE_BY_NAME: Record<string, keyof AdminStore> = {
  admin_users: 'users',
  admin_sessions: 'sessions',
  admin_password_resets: 'passwordResets',
  admin_passkeys: 'passkeys',
  admin_webauthn_challenges: 'challenges',
  admin_events: 'events',
};

function resolveTable(raw: unknown): keyof AdminStore | null {
  if (!raw || typeof raw !== 'object') return null;
  try {
    const name = getTableName(raw as Parameters<typeof getTableName>[0]);
    return TABLE_BY_NAME[name] ?? null;
  } catch {
    return null;
  }
}

const COLUMN_MAP: Record<keyof AdminStore, Record<string, string>> = {
  users: {
    id: 'id',
    name: 'name',
    username: 'username',
    email: 'email',
    password_hash: 'passwordHash',
    access_level: 'accessLevel',
    active: 'active',
    last_login_at: 'lastLoginAt',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
  },
  sessions: {
    id: 'id',
    user_id: 'userId',
    token_hash: 'tokenHash',
    ip: 'ip',
    user_agent: 'userAgent',
    created_at: 'createdAt',
    last_seen_at: 'lastSeenAt',
    expires_at: 'expiresAt',
  },
  passwordResets: {
    id: 'id',
    user_id: 'userId',
    token_hash: 'tokenHash',
    expires_at: 'expiresAt',
    used_at: 'usedAt',
    created_at: 'createdAt',
  },
  passkeys: {
    id: 'id',
    user_id: 'userId',
    credential_id: 'credentialId',
    credential_id_hash: 'credentialIdHash',
    public_key_pem: 'publicKeyPem',
    cose_alg: 'coseAlg',
    sign_count: 'signCount',
    name: 'name',
    transports: 'transports',
    aaguid: 'aaguid',
    created_at: 'createdAt',
    last_used_at: 'lastUsedAt',
  },
  challenges: {
    id: 'id',
    challenge: 'challenge',
    user_id: 'userId',
    type: 'type',
    expires_at: 'expiresAt',
    created_at: 'createdAt',
  },
  events: {
    id: 'id',
    type: 'type',
    host_id: 'hostId',
    payload: 'payload',
    created_at: 'createdAt',
  },
  nextId: {},
};

interface ColumnTag {
  tableKey: keyof AdminStore;
  fieldName: string;
}

function readColumn(value: unknown): ColumnTag | null {
  if (value && typeof value === 'object') {
    const v = value as { name?: string; table?: unknown };
    if (typeof v.name === 'string' && v.table) {
      const tableKey = resolveTable(v.table);
      const fieldName = tableKey ? COLUMN_MAP[tableKey][v.name] : undefined;
      if (tableKey && fieldName) return { tableKey, fieldName };
    }
  }
  return null;
}

// Returns the literal string value carried inside a Drizzle StringChunk
// (which stores its value as an Array<string> — never a bare string, that
// shape belongs to `Param`).
function readStringChunk(value: unknown): string | null {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    const raw = (value as { value: unknown; constructor?: { name?: string } }).value;
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctor === 'StringChunk' && Array.isArray(raw) && raw.every((v) => typeof v === 'string')) {
      return raw.join('');
    }
  }
  if (typeof value === 'string') return value;
  return null;
}

// Returns the bound parameter value from a Drizzle Param wrapper.
function readParamValue(value: unknown): { ok: true; value: unknown } | null {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    const raw = (value as { value: unknown; constructor: { name?: string } }).value;
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctor === 'Param') return { ok: true, value: raw };
    // Drizzle params can also come through as plain wrappers in some chunks.
    if (!Array.isArray(raw) && typeof raw !== 'object') return { ok: true, value: raw };
  }
  return null;
}

// Walks a Drizzle SQL chunk and returns a predicate(row, joinRow?) => bool.
function compileSqlPredicate(
  value: unknown,
): (row: Record<string, unknown>, joinRow?: Record<string, unknown>) => boolean {
  if (!value || typeof value !== 'object') return () => true;
  const v = value as { queryChunks?: unknown[] };
  if (!Array.isArray(v.queryChunks)) return () => true;

  // Strip outer "(" ... ")" parens emitted by `and`/`or` wrappers.
  const inner: unknown[] = [];
  for (const chunk of v.queryChunks) {
    const str = readStringChunk(chunk);
    if (str === '(' || str === ')') continue;
    inner.push(chunk);
  }

  // CASE A: composite — inner contains a single nested SQL with " and "/" or "
  // separators between sub-SQLs.
  if (inner.length === 1) {
    const sole = inner[0];
    if (sole && typeof sole === 'object' && Array.isArray((sole as { queryChunks?: unknown[] }).queryChunks)) {
      const subChunks = (sole as { queryChunks: unknown[] }).queryChunks;
      const subPreds: Array<(r: Record<string, unknown>, j?: Record<string, unknown>) => boolean> = [];
      let separator: 'and' | 'or' = 'and';
      for (const sc of subChunks) {
        if (sc && typeof sc === 'object' && Array.isArray((sc as { queryChunks?: unknown[] }).queryChunks)) {
          subPreds.push(compileSqlPredicate(sc));
          continue;
        }
        const str = readStringChunk(sc);
        if (str && /\s+or\s+/i.test(str)) separator = 'or';
      }
      if (subPreds.length >= 1) {
        return (row, joinRow) =>
          separator === 'or'
            ? subPreds.some((p) => p(row, joinRow))
            : subPreds.every((p) => p(row, joinRow));
      }
    }
  }

  // CASE B: simple comparator. Walk the chunks finding [col, op-string, val].
  let leftCol: ColumnTag | null = null;
  let rightCol: ColumnTag | null = null;
  let rightVal: unknown = undefined;
  let haveRightVal = false;
  let op: 'eq' | 'ne' | 'gt' | 'lt' | null = null;
  let isNull = false;
  let isNotNull = false;

  for (const chunk of v.queryChunks) {
    const str = readStringChunk(chunk);
    if (str !== null) {
      const s = str.toLowerCase();
      if (/\s=\s/.test(s)) op = 'eq';
      else if (/\s<>\s/.test(s)) op = 'ne';
      else if (/\s>\s/.test(s)) op = 'gt';
      else if (/\s<\s/.test(s)) op = 'lt';
      if (/is\s+null/.test(s)) isNull = true;
      if (/is\s+not\s+null/.test(s)) isNotNull = true;
      continue;
    }
    const col = readColumn(chunk);
    if (col) {
      if (!leftCol) leftCol = col;
      else rightCol = col;
      continue;
    }
    const param = readParamValue(chunk);
    if (param && !haveRightVal) {
      rightVal = param.value;
      haveRightVal = true;
    }
  }

  return (row, joinRow) => {
    if (!leftCol) return true;
    const lhs = row[leftCol.fieldName];
    if (isNull) return lhs == null;
    if (isNotNull) return lhs != null;
    if (!op) return true;
    const rhs = rightCol ? (joinRow ?? {})[rightCol.fieldName] : rightVal;
    switch (op) {
      case 'eq':
        return looseEqual(lhs, rhs);
      case 'ne':
        return !looseEqual(lhs, rhs);
      case 'gt':
        return String(lhs ?? '') > String(rhs ?? '');
      case 'lt':
        return String(lhs ?? '') < String(rhs ?? '');
    }
  };
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

function findColumnInSql(value: unknown): ColumnTag | null {
  const direct = readColumn(value);
  if (direct) return direct;
  if (value && typeof value === 'object' && Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) {
      const col = readColumn(chunk);
      if (col) return col;
    }
  }
  return null;
}

function runSelect(store: AdminStore, chain: CallNode | undefined): unknown[] {
  if (!chain) return [];
  const selectArgs = chain.args[0] as Record<string, unknown> | undefined;
  let next = chain.next;
  let tableKey: keyof AdminStore | null = null;
  let joinedKey: keyof AdminStore | null = null;
  let joinPred: ((row: Record<string, unknown>, joinRow?: Record<string, unknown>) => boolean) | null = null;
  let wherePred: ((row: Record<string, unknown>, joinRow?: Record<string, unknown>) => boolean) | null = null;
  let limit: number | null = null;
  let orderColumn: ColumnTag | null = null;
  while (next) {
    if (next.method === 'from') tableKey = resolveTable(next.args[0]);
    else if (next.method === 'innerJoin') {
      joinedKey = resolveTable(next.args[0]);
      joinPred = compileSqlPredicate(next.args[1]);
    } else if (next.method === 'where') wherePred = compileSqlPredicate(next.args[0]);
    else if (next.method === 'limit') limit = Number(next.args[0]);
    else if (next.method === 'orderBy') orderColumn = findColumnInSql(next.args[0]);
    next = next.next;
  }
  if (!tableKey) return [];

  const baseRows = (store[tableKey] as unknown as Array<Record<string, unknown>>) ?? [];
  if (joinedKey && joinPred) {
    const rightRows = (store[joinedKey] as unknown as Array<Record<string, unknown>>) ?? [];
    let joined: Array<{ left: Record<string, unknown>; right: Record<string, unknown> }> = [];
    for (const l of baseRows) {
      for (const r of rightRows) {
        if (joinPred(l, r)) joined.push({ left: l, right: r });
      }
    }
    if (wherePred) {
      joined = joined.filter(({ left, right }) => wherePred!(left, right));
    }
    if (limit) joined = joined.slice(0, limit);
    // Return shape per the user/session join used in resolveSession()
    return joined.map(({ left, right }) => ({
      session: tableKey === 'sessions' ? left : joinedKey === 'sessions' ? right : null,
      user: tableKey === 'users' ? left : joinedKey === 'users' ? right : null,
    }));
  }

  let rows: Array<Record<string, unknown>> = baseRows;
  if (wherePred) rows = rows.filter((r) => wherePred!(r));
  if (orderColumn) {
    rows = [...rows].sort((a, b) => {
      const av = String(a[orderColumn!.fieldName] ?? '');
      const bv = String(b[orderColumn!.fieldName] ?? '');
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
  }

  // count() aggregate detection — Drizzle wraps strings inside StringChunk.
  if (selectArgs && typeof selectArgs === 'object') {
    const entries = Object.entries(selectArgs);
    if (entries.length === 1) {
      const value = entries[0]![1] as { queryChunks?: unknown[] } | undefined;
      const chunks = value && Array.isArray(value.queryChunks) ? value.queryChunks : null;
      const hasCount = chunks?.some((c) => {
        const str = readStringChunk(c);
        return str !== null && /count\(/i.test(str);
      });
      if (hasCount) return [{ [entries[0]![0]]: rows.length }];
    }
  }

  if (limit) rows = rows.slice(0, limit);
  return rows;
}

function runInsert(store: AdminStore, chain: CallNode): unknown[] {
  const tableKey = resolveTable(chain.args[0]);
  if (!tableKey || tableKey === 'nextId') return [{ insertId: 0, affectedRows: 0 }];
  let values: Array<Record<string, unknown>> = [];
  let cursor: CallNode | undefined = chain.next;
  while (cursor) {
    if (cursor.method === 'values') {
      const raw = cursor.args[0];
      values = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [raw as Record<string, unknown>];
      break;
    }
    cursor = cursor.next;
  }
  const list = store[tableKey] as unknown as Array<Record<string, unknown>>;
  const inserted: Array<{ insertId: number; affectedRows: number }> = [];
  for (const row of values) {
    const id = store.nextId++;
    list.push({ id, ...row });
    inserted.push({ insertId: id, affectedRows: 1 });
  }
  return inserted.length > 0 ? inserted : [{ insertId: 0, affectedRows: 0 }];
}

function runUpdate(store: AdminStore, chain: CallNode): unknown[] {
  const tableKey = resolveTable(chain.args[0]);
  if (!tableKey || tableKey === 'nextId') return [{ affectedRows: 0 }];
  let patch: Record<string, unknown> = {};
  let wherePred: ((row: Record<string, unknown>) => boolean) | null = null;
  let cursor: CallNode | undefined = chain.next;
  while (cursor) {
    if (cursor.method === 'set') patch = (cursor.args[0] as Record<string, unknown>) ?? {};
    if (cursor.method === 'where') wherePred = compileSqlPredicate(cursor.args[0]);
    cursor = cursor.next;
  }
  let affected = 0;
  const list = store[tableKey] as unknown as Array<Record<string, unknown>>;
  for (const row of list) {
    if (!wherePred || wherePred(row)) {
      Object.assign(row, patch);
      affected++;
    }
  }
  return [{ affectedRows: affected }];
}

function runDelete(store: AdminStore, chain: CallNode): unknown[] {
  const tableKey = resolveTable(chain.args[0]);
  if (!tableKey || tableKey === 'nextId') return [{ affectedRows: 0 }];
  let wherePred: ((row: Record<string, unknown>) => boolean) | null = null;
  let cursor: CallNode | undefined = chain.next;
  while (cursor) {
    if (cursor.method === 'where') wherePred = compileSqlPredicate(cursor.args[0]);
    cursor = cursor.next;
  }
  const list = store[tableKey] as unknown as Array<Record<string, unknown>>;
  let affected = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const row = list[i];
    if (row && (!wherePred || wherePred(row))) {
      list.splice(i, 1);
      affected++;
    }
  }
  return [{ affectedRows: affected }];
}

function makeFakeDb(store: AdminStore) {
  return {
    select(selection?: Record<string, unknown>) {
      return buildChain('select', [selection], (chain) => runSelect(store, chain));
    },
    insert(table: unknown) {
      return buildChain('insert', [table], (chain) => runInsert(store, chain));
    },
    update(table: unknown) {
      return buildChain('update', [table], (chain) => runUpdate(store, chain));
    },
    delete(table: unknown) {
      return buildChain('delete', [table], (chain) => runDelete(store, chain));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Test app
// ─────────────────────────────────────────────────────────────────────────

export interface AdminTestApp {
  app: FastifyInstance;
  store: AdminStore;
  env: Env;
  sessionToken: (userId: number) => { token: string; cookie: string };
}

export async function buildAdminTestApp(envPatch: Partial<Env> = {}): Promise<AdminTestApp> {
  const store = emptyStore();
  const db = makeFakeDb(store);
  const env = { ...TEST_ENV, ...envPatch } as Env;

  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);

  const cookieName = env.ADMIN_SESSION_COOKIE;

  app.decorate('resolveAdmin', async function resolveAdmin(req: import('fastify').FastifyRequest): Promise<AdminContext | null> {
    const token = req.cookies?.[cookieName];
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = store.sessions.find((s) => s.tokenHash === tokenHash);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
    const user = store.users.find((u) => u.id === session.userId);
    if (!user || user.active !== 1) return null;
    return { user, session };
  } as never);

  app.decorate('requireAdmin', async function requireAdmin(req: import('fastify').FastifyRequest) {
    const ctx = await (app as unknown as { resolveAdmin: (req: unknown) => Promise<AdminContext | null> }).resolveAdmin(req);
    if (!ctx) throw new UnauthorizedError('Admin session required', 'admin_required');
    if (!ctx.user.active) throw new ForbiddenError('Account disabled', 'admin_disabled');
    (req as { admin?: AdminContext }).admin = ctx;
  } as never);

  // For routes that read off `app.db` / `app.env`.
  app.decorate('db', db as unknown as import('../../src/db/client.js').Database);
  app.decorate('env', env);

  await registerAdminAuthAndUsersRoutes(app, {
    db: db as unknown as import('../../src/db/client.js').Database,
    env,
    keyring: {} as never,
  });

  const sessionToken = (userId: number): { token: string; cookie: string } => {
    const token = Buffer.from(`test-token-${userId}-${store.nextId++}`).toString('hex');
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = new Date().toISOString();
    store.sessions.push({
      id: store.nextId++,
      userId,
      tokenHash,
      ip: null,
      userAgent: null,
      createdAt: created,
      lastSeenAt: created,
      expiresAt,
    });
    return { token, cookie: `${cookieName}=${token}` };
  };

  return { app, store, env, sessionToken };
}

export { emptyStore };
