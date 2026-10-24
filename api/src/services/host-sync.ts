import { ownerRuntimeFor, mutateOwnerState, type OwnerRuntime } from '../control-plane/state/runtime.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { NotFoundError } from '../http/errors.js';
import { eq, sql } from 'drizzle-orm';
import { hostUsers, type Host } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import type { VersionSnapshotService, VersionSnapshot } from './version-snapshot.js';
import { applyHostVersionPolicy } from './version-snapshot.js';

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
  // Bootstrap already needs this request's snapshot for its projected auth
  // response; reuse it rather than refreshing a value it immediately replaces.
  versionSnapshot?: VersionSnapshot;
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

const userObservations=new WeakMap<OwnerRuntime,Map<number,string>>();
function observeUser(owner:OwnerRuntime,id:number){let rows=userObservations.get(owner);if(!rows){rows=new Map();userObservations.set(owner,rows);const observations=rows;owner.state.subscribe(snapshot=>{for(const key of observations.keys())if(!snapshot.table('hostUsers').has(key))observations.delete(key);});}rows.set(id,nowIso());}

export function createHostSyncService(deps: HostSyncDeps): HostSyncService {
  const { db, versions } = deps;

  return {
    async collect({ host, engine, bootstrap, users, versionSnapshot }) {
      const summary = applyHostVersionPolicy(versionSnapshot ?? await versions.summary(engine), host, engine);
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
      const owner=ownerRuntimeFor(db);
      if(owner){
        owner.assertOwner();
        if(u){const prior=owner.state.snapshot().table('hostUsers').by('hostId',hostId).find(row=>row.username===u);
          // Content sync records new users and hostname changes. Transport
          // presence already owns ongoing liveness, so unchanged sync is read-only.
          if(!prior||hostname!==null&&hostname!==prior.hostname)await mutateOwnerState(owner,{kind:'host.user.register',payload:{hostId,username:u,hostname},prepare(ctx){
            if(!ctx.snapshot.hosts.has(hostId))throw new NotFoundError('Host not found');
            const existing=ctx.snapshot.table('hostUsers').by('hostId',hostId).find(row=>row.username===u),now=nowIso();
            if(existing){if(hostname!==null&&hostname!==existing.hostname)stageUpdate(ctx,'hostUsers',existing.id,{hostname,lastSeen:now});}
            else{const row={hostId,username:u,hostname,firstSeen:now,lastSeen:now};ctx.write(async tx=>{const [result]=await tx.insert(hostUsers).values(row);ctx.draft.upsert('hostUsers',{...row,id:Number(result.insertId)});});}return null;
          }});
        }
        const observed=owner.state.snapshot().table('hostUsers').by('hostId',hostId).find(row=>row.username===u);if(observed)observeUser(owner,observed.id);
        return readUsers(db,hostId);
      }

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
  const owner=ownerRuntimeFor(db);if(owner){owner.assertOwner();return owner.state.snapshot().table('hostUsers').by('hostId',hostId).map(row=>({username:row.username,hostname:row.hostname??null,last_seen:userObservations.get(owner)?.get(row.id)??row.lastSeen}));}
  const rows = await db.select().from(hostUsers).where(eq(hostUsers.hostId, hostId));
  return rows.map((r) => ({ username: r.username, hostname: r.hostname ?? null, last_seen: r.lastSeen }));
}
