import { eq, sql } from 'drizzle-orm';
import { hostUsers, type Host } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import type { VersionSnapshotService, VersionSnapshot } from './version-snapshot.js';
import { applyHostClientVersionPin } from './version-snapshot.js';

/**
 * Port of StartupSyncService::collect (used for /sync/status + /sync/bootstrap
 * responses). The legacy service also mixes in skill manifest + agents-doc +
 * client-config rendering — those live in their own worktrees, so this
 * service returns a minimal-but-honest payload and lets routes attach the
 * `auth` envelope separately.
 */

export interface SyncCollectInput {
  host: Host;
  engine: Engine;
  bootstrap: boolean;
  // Callers reach `collect` via `recordHostUser`, which already returns the
  // host's users -- they hand that array back instead of making us re-read it.
  users: Array<{ username: string; hostname: string | null; last_seen: string }>;
}

export interface SyncCollectResult {
  status: 'ok' | 'update';
  reasons: string[];
  engine: Engine;
  versions: VersionSnapshot;
  api_calls: number;
  host_users: Array<{ username: string; hostname: string | null; last_seen: string }>;
  bootstrap: boolean;
  // Free-form extras (auth envelope etc. injected by route handlers)
  [key: string]: unknown;
}

export interface HostSyncService {
  collect(input: SyncCollectInput): Promise<SyncCollectResult>;
  recordHostUser(hostId: number, username: string | null, hostname: string | null): Promise<Array<{ username: string; hostname: string | null; last_seen: string }>>;
}

export interface HostSyncDeps {
  db: Database;
  versions: VersionSnapshotService;
}

export function createHostSyncService(deps: HostSyncDeps): HostSyncService {
  const { db, versions } = deps;

  return {
    async collect({ host, engine, bootstrap, users }) {
      const summary = applyHostClientVersionPin(await versions.summary(engine), host, engine);
      return {
        status: 'ok',
        reasons: [],
        engine,
        versions: summary,
        api_calls: Number(host.apiCalls ?? 0),
        host_users: users,
        bootstrap,
      };
    },

    async recordHostUser(hostId, username, hostname) {
      const u = (username ?? '').trim();
      if (u !== '') {
        const now = nowIso();
        await db
          .insert(hostUsers)
          .values({
            hostId,
            username: u,
            hostname: hostname ?? undefined,
            firstSeen: now,
            lastSeen: now,
          })
          .onDuplicateKeyUpdate({
            set: { lastSeen: now, hostname: sql`coalesce(values(hostname), hostname)` },
          });
      }
      return readUsers(db, hostId);
    },
  };
}

async function readUsers(
  db: Database,
  hostId: number,
): Promise<Array<{ username: string; hostname: string | null; last_seen: string }>> {
  const rows = await db.select().from(hostUsers).where(eq(hostUsers.hostId, hostId));
  return rows.map((r) => ({ username: r.username, hostname: r.hostname ?? null, last_seen: r.lastSeen }));
}
