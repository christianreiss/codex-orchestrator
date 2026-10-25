import { persistAuditLog } from './audit-log.js';
import { resumedNativeAttachment } from '../control-plane/state/native-resume.js';
import { normalizeRemote } from './git-director/remote-normalization.js';
export { normalizeRemote } from './git-director/remote-normalization.js';
import { legacyDrainFor } from '../control-plane/legacy-drain.js';
import { currentNativePrincipal, withNativePrincipal } from '../control-plane/state/native-principal.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getTableColumns } from 'drizzle-orm';
import type { AnyMySqlTable, AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import { mutateOwnerState, ownerRuntimeFor, type OwnerMutationContext } from '../control-plane/state/runtime.js';
import type { OwnerStateSnapshot } from '../control-plane/state/store.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { nativeClaimAttachment } from '../control-plane/state/resource-claims.js';
import { activeHostEngines } from './host-engine-policy.js';
import { ownedMessagingHost, ownedEngineState, ownedBridge } from '../control-plane/state/messaging.js';
import type { Json } from '../control-plane/commands.js';
import { adminAudit } from '../control-plane/state/admin.js';
import { versions } from '../db/schema.js';
import type { ManagedHost as Host } from '../control-plane/state/host-registration.js';
import { remoteGitOwner, remoteAddress, type GitProvenance } from './git-director/remote.js';
import { GitDirectorNotifications, type DirectorEvent } from './git-director/notifications.js';
import { readWorkspace } from './agent-messaging/workspace.js';
import { lockClaimGate, guardGitMutation } from './agent-coordination/git-guard.js';
/**
 * Git Director: a registry of who is working in which clone, plus an advisory
 * arbiter over merges into shared branches.
 *
 * The orchestrator has no filesystem access to any host. It cannot merge, cannot
 * read an index, and cannot verify that an agent did what it said. Every git
 * fact here is REPORTED by the agent that owns the worktree, and the verdict is
 * advice that agent is free to ignore. That is deliberate: enforcement would
 * mean writing hooks into the operator's `.git`, and an agent willing to
 * fabricate its own diff was already willing to ignore the answer. What the
 * Director actually buys is that four agents in four worktrees can see each
 * other, and that "wait" arrives with the reason attached.
 *
 * The arbitration unit is the CLONE ON A HOST, keyed by
 * `git rev-parse --git-common-dir`, because that is the contention that exists:
 * linked worktrees of one checkout racing for one branch. Clones are grouped
 * across hosts by normalized remote for visibility only — a local merge on one
 * machine must never block a different machine.
 *
 * Caller identity is the worktree PATH, not the credential. `POST /mcp`
 * authenticates a host, and every agent on that box shares one API key, so the
 * credential cannot distinguish two worktrees. Where Agent Messaging is on we
 * join `agent_bus_addresses` on (host_id, cwd_hash) to enrich a registration
 * with its address and engine — enrichment only; the feature works with Agent
 * Messaging off.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  adminEvents,
  agentBusAddresses,
  agentSessions,
  gitClones,
  gitMergeRequests,
  gitWorktrees,
  hosts,
  type GitClone,
  type GitMergeRequest,
  type GitWorktree,
} from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { AGENT_PRESENCE_FRESH_SECONDS, deriveAddressPresence, isPresent } from './agent-presence.js';
import { nowIso, isoOffsetSeconds, parseIso } from '../util/timestamp.js';
import { isEngine } from '../util/engine.js';
import { SettingsService } from './settings.js';
import { wsPublisher } from '../ws/publisher.js';

/** The `versions` row that switches the whole module on. Absent means off. */
export const GIT_DIRECTOR_ENABLED_FLAG = 'git_director_enabled';

function nativeRegistrationRequired(message: string, workspaceMismatch = false) {
  const recovery = workspaceMismatch
    ? ' Bind the actual absolute checkout and common directory with agent_context_update before registering a nested repository or worktree.'
    : ' Run cxx communicator status; use the original managed native process and its private MCP broker, then retry. agent_self or naming alone does not establish connection proof.';
  return new ConflictError(message + recovery, 'git_director_owner_required');
}

/** Optional `versions` row naming the model used for contended verdicts. */
export const GIT_DIRECTOR_MODEL_KEY = 'git_director_model';

export const GIT_DIRECTOR_DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * How long a registration survives without a heartbeat, and how long a granted
 * lease survives without a renew. Both are load-bearing: agents die mid-session
 * constantly, and without a TTL the first crashed one wedges its clone forever
 * and the feature gets switched off. Expiry is swept on read rather than by
 * cron, matching the call-PIN sweep in agent-messaging.ts.
 */
export const REGISTRATION_TTL_SECONDS = 3600;
export const LEASE_TTL_SECONDS = 900;

/** Cap on reported path lists, so one enormous diff cannot bloat a row or a prompt. */
const MAX_PATHS = 500;
const MAX_TASK_LENGTH = 2000;
const MAX_PATH_LENGTH = 1024;

export type GitDirectorDb = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

export type Verdict = 'allow' | 'wait' | 'deny';
export type DecidedBy = 'policy' | 'llm' | 'operator';

export interface MergeBriefContender {
  worktree_path: string;
  branch: string | null;
  username: string;
  task: string | null;
  /** How long this contender has held the lease, in seconds. Null when queued. */
  held_for_seconds: number | null;
}

export interface MergeBrief {
  target_branch: string;
  requester: MergeBriefContender;
  holder: MergeBriefContender | null;
  /** Paths the requester and the holder both touch. Computed, never agent prose. */
  overlap: string[];
  requester_path_count: number;
  queue_depth: number;
}

export interface JudgeVerdict {
  verdict: Verdict;
  reason: string;
  wait_seconds?: number;
}

/**
 * The contended-path arbiter. Returning `null` — from an unconfigured runner, a
 * timeout, or output that is not one of the three verdicts — sends the caller
 * down the deterministic fallback. That is the whole contract: a judge may
 * decline, it may never block.
 */
export interface GitDirectorJudge {
  readonly model: string;
  judge(brief: MergeBrief): Promise<JudgeVerdict | null>;
}

export interface GitDirectorServiceDeps {
  db: Database;
  settings: SettingsService;
  judge?: GitDirectorJudge | null;
  now?: () => string;
  /**
   * Liveness window for the addresses this Director consumes, in seconds.
   * Callers that can reach env should pass `AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS`
   * so the Director and Agent Messaging cannot disagree about who is alive;
   * without it both fall back to the same shared default.
   */
  freshSeconds?: number;
  notifications?: GitDirectorNotifications;
}

// ── pure helpers (exported for unit tests) ───────────────────────────────────

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Absolute-path normalization: collapse duplicate and trailing separators. */
export function normalizePath(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const collapsed = value.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/**
 * Paths both sides touch. A directory prefix counts: one agent rewriting
 * `api/src/services/` and another editing a file inside it are in each other's
 * way even though no exact path repeats.
 */
export function overlappingPaths(left: readonly string[], right: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) hits.add(a);
    }
  }
  return [...hits].sort();
}

/** A non-holding peer whose `git_join` declarations cover some changed paths. */
export interface PeerOverlap {
  worktree_id: string;
  worktree_path: string;
  username: string;
  branch: string | null;
  /** Requester's changed paths that fall on or under this peer's declarations. */
  paths: string[];
}

/**
 * Changed paths that land on what live peers declared via `git_join`, per peer.
 * Uses the same segment-aware prefix rule as {@link overlappingPaths}, so a
 * declared `docs` covers `docs/x.md` and a declared `doc` does not.
 */
export function peerDeclarationOverlap(
  changedPaths: readonly string[],
  peers: ReadonlyArray<{
    worktree_id: string;
    worktree_path: string;
    username: string;
    branch: string | null;
    declared_paths: readonly string[];
  }>,
): PeerOverlap[] {
  const out: PeerOverlap[] = [];
  for (const peer of peers) {
    const paths = overlappingPaths(changedPaths, peer.declared_paths);
    if (paths.length === 0) continue;
    out.push({
      worktree_id: peer.worktree_id,
      worktree_path: peer.worktree_path,
      username: peer.username,
      branch: peer.branch,
      paths,
    });
  }
  return out;
}

function cleanPaths(raw: unknown): string[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const entry of list) {
    const value = normalizePath(String(entry ?? ''));
    if (!value || value.length > MAX_PATH_LENGTH) continue;
    if (!out.includes(value)) out.push(value);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

/**
 * Registration binding state, mirrored from `git_list`'s `agent_address_bound`
 * so an unbound registration is visible at registration time instead of first
 * surfacing as an unattributable claim at the merge guard.
 */
function bindingWire(address: { id: string } | null): Record<string, unknown> {
  if (address) return { agent_address_bound: true };
  return {
    agent_address_bound: false,
    binding_hint:
      'No unique live agent session on this host matched engine, username and this worktree directory, so ' +
      'resource claims cannot be attributed to this registration. Pass username and engine, and run ' +
      'agent_context_update with this worktree as cwd/git_root first if your session started elsewhere.',
  };
}

function readPaths(raw: unknown): string[] {
  // JSON columns come back parsed on MySQL and as text on some drivers.
  if (typeof raw === 'string') {
    try {
      return cleanPaths(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return cleanPaths(raw);
}

function requiredString(args: Record<string, unknown>, key: string, max = 1024): string {
  const value = String(args[key] ?? '').trim();
  if (!value) throw new ValidationError(`${key} is required`, { param: key });
  if (value.length > max) throw new ValidationError(`${key} is too long`, { param: key });
  return value;
}

function optionalString(args: Record<string, unknown>, key: string, max = 1024): string | null {
  const value = String(args[key] ?? '').trim();
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Default and ceiling page sizes for `git_list`; see {@link summarizeCloneEntry}. */
const LIST_SUMMARY_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;
const LIST_SUMMARY_WORKTREE_CAP = 25;
const LIST_SUMMARY_TASK_CHARS = 120;

function listInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The compact shape `git_list` returns by default.
 *
 * The full listing carries every worktree's declared paths and task, every
 * lease's reason and overlap, and up to 25 stale registrations per clone, which
 * is what pushed one busy host past 68k characters and past the tool-result
 * window of the clients that call it (the agent then never saw the registry at
 * all). The summary keeps what the pre-work "who is in my checkout" question
 * needs: where each clone is, who is registered in it, on which branch, and
 * whether a lease is live. Counts replace the lists that were dropped, and
 * `detail: "full"` or `scope: "clone"` brings the whole entry back.
 */
export function summarizeCloneEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const worktrees = Array.isArray(entry['worktrees']) ? (entry['worktrees'] as Array<Record<string, unknown>>) : [];
  const leases = Array.isArray(entry['leases']) ? (entry['leases'] as Array<Record<string, unknown>>) : [];
  const stale = Array.isArray(entry['stale']) ? (entry['stale'] as unknown[]) : [];
  const { worktrees: _w, leases: _l, stale: _s, ...clone } = entry;
  void _w;
  void _l;
  void _s;
  const clip = (value: unknown): unknown =>
    typeof value === 'string' && value.length > LIST_SUMMARY_TASK_CHARS
      ? `${value.slice(0, LIST_SUMMARY_TASK_CHARS)}…`
      : value;
  return {
    ...clone,
    worktree_count: worktrees.length,
    worktrees: worktrees.slice(0, LIST_SUMMARY_WORKTREE_CAP).map((w) => ({
      worktree_id: w['worktree_id'],
      worktree_path: w['worktree_path'],
      username: w['username'],
      engine: w['engine'],
      branch: w['branch'],
      head_sha: w['head_sha'],
      task: clip(w['task']),
      target_branch: w['target_branch'],
      heartbeat_at: w['heartbeat_at'],
      status: w['status'], ownership_mode: w['ownership_mode'], uncertainty_reason: w['uncertainty_reason'], presence_source: w['presence_source'], expires_at: w['expires_at'],
    })),
    worktrees_truncated: worktrees.length > LIST_SUMMARY_WORKTREE_CAP,
    lease_count: leases.length,
    leases: leases.map((l) => ({
      request_id: l['request_id'],
      worktree_id: l['worktree_id'],
      target_branch: l['target_branch'],
      verdict: l['verdict'],
      lease_expires_at: l['lease_expires_at'],
    })),
    // Capped at 25 per clone, like the full listing; only the count is kept.
    stale_count: stale.length,
  };
}

function secondsBetween(from: string | null, to: string): number | null {
  const start = parseIso(from);
  const end = parseIso(to);
  if (!start || !end) return null;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

function isExpired(at: string | null | undefined, now: string): boolean {
  if (!at) return false;
  const deadline = parseIso(at);
  const current = parseIso(now);
  if (!deadline || !current) return false;
  return deadline.getTime() <= current.getTime();
}

export interface GitDirectorModuleState {
  enabled: boolean;
  model: string;
  clones: number;
  worktrees: number;
  updated_at: string | null;
}

const ownedGitTables = { gitClones, gitWorktrees, gitMergeRequests };
type GitTableName=keyof typeof ownedGitTables;
type GitRow<K extends GitTableName>=(typeof ownedGitTables)[K]['$inferSelect'];
export class GitDirectorService {
  private readonly now: () => string;
  private readonly evaluatedWaits = new Map<string,string>();

  constructor(private readonly deps: GitDirectorServiceDeps) {
    this.now = deps.now ?? nowIso;
  }

  private readonly ownedContext = new AsyncLocalStorage<{ctx:OwnerMutationContext;checks:Array<(snapshot:OwnerStateSnapshot)=>void>}>();
  private snapshot(db: GitDirectorDb = this.deps.db): OwnerStateSnapshot | undefined {
    const owner=ownerRuntimeFor(db);if(!owner)return undefined;owner.assertOwner();
    return this.ownedContext.getStore()?.ctx.draft.view()??owner.state.snapshot();
  }
  private rows<K extends GitTableName>(db:GitDirectorDb,name:K): GitRow<K>[] | undefined {
    const snapshot=this.snapshot(db);return snapshot?[...snapshot.table(name).all()] as unknown as GitRow<K>[]:undefined;
  }
  private async updateRows<K extends GitTableName>(db:GitDirectorDb,name:K,ids:readonly string[],patch:Partial<GitRow<K>>):Promise<void>{
    if(!ids.length)return;
    if(ownerRuntimeFor(db)){
      const context=this.ownedContext.getStore()?.ctx;if(!context)throw new Error('Git mutation requires an owner command');
      for(const id of ids)stageUpdate(context,name,id,patch);
      return;
    }
    const table=ownedGitTables[name] as AnyMySqlTable,columns=getTableColumns(table) as Record<string,AnyMySqlColumn>;
    await db.update(table).set(patch).where(inArray(columns.id!,[...ids]));
  }
  private async insertRow<K extends GitTableName>(db:GitDirectorDb,name:K,values:(typeof ownedGitTables)[K]['$inferInsert']):Promise<void>{
    if(ownerRuntimeFor(db)){
      const context=this.ownedContext.getStore()?.ctx;if(!context)throw new Error('Git mutation requires an owner command');
      const full:Record<string,unknown>={};
      for(const [key,column]of Object.entries(getTableColumns(ownedGitTables[name]))){
        const value=(values as Record<string,unknown>)[key];
        if(value!==undefined)full[key]=value;
        else if(column.default!==undefined&&(column.default===null||typeof column.default!=='object'))full[key]=column.default;
        else if(!column.notNull)full[key]=null;
        else throw new Error(`Missing explicit Git ${name}.${key}`);
      }
      context.draft.upsert(name,full as GitRow<K>);
      context.write(async tx=>tx.insert(ownedGitTables[name] as AnyMySqlTable).values(values));return;
    }
    await db.insert(ownedGitTables[name] as AnyMySqlTable).values(values);
  }

  private registrationProof(row: GitWorktree, snapshot = this.snapshot()): boolean {
    const owner = ownerRuntimeFor(this.deps.db);
    if (!owner || !snapshot || !row.agentSessionId) return false;
    const session = snapshot.sessions.get(row.agentSessionId);
    if (!session || session.endedAt || session.bindingGeneration !== row.agentBindingGeneration || session.agentBusAddressId !== row.agentBusAddressId) return false;
    try { const host=ownedMessagingHost(snapshot, session.hostId); if (host.authFingerprint !== session.hostAuthFingerprint || !isEngine(session.engine) || !activeHostEngines(host.engines,ownedEngineState(snapshot)).includes(session.engine)) return false; } catch { return false; }
    if (row.ownershipMode === 'timed') return Boolean(legacyDrainFor(owner)?.gitRegistration(row.id, session.id, session.bindingGeneration));
    return Boolean(row.nativeInstanceId && nativeClaimAttachment(owner, session, row.nativeInstanceId));
  }
  private registrationExpiresAt(row: GitWorktree): string | null {
    if (row.ownershipMode === 'connection') return null;
    const owner = ownerRuntimeFor(this.deps.db);
    const drain = owner && legacyDrainFor(owner);
    const deadline = drain && row.agentSessionId && row.agentBindingGeneration !== null &&
      drain.gitRegistration(row.id, row.agentSessionId, row.agentBindingGeneration)
      ? drain.protectedDeadline(row.agentSessionId, row.agentBindingGeneration) : null;
    return deadline === null ? row.expiresAt : new Date(deadline).toISOString();
  }
  private requireRegistrationProof(row: GitWorktree, requireCaller = false): void {
    const principal = currentNativePrincipal();
    const check = (snapshot = this.snapshot()) => {
      if (!snapshot || !this.registrationProof(row,snapshot)) throw new ConflictError('The original native instance must reattach; this registration retains exclusion.', 'git_director_owner_uncertain');
      if (principal || requireCaller) {
        if (!principal) throw nativeRegistrationRequired('Authenticated original session required for registration changes');
        const {session} = ownedBridge(snapshot,principal.sessionId,principal.bridgeToken);
        if (session.id !== row.agentSessionId || session.bindingGeneration !== row.agentBindingGeneration)
          throw new ConflictError('Registration belongs to another session binding','git_director_owner_uncertain');
      }
    };
    check();
    this.ownedContext.getStore()?.checks.push(check);
  }
  private readonly broadcasts = new WeakMap<object, Array<{ type: string; payload: Record<string, unknown> }>>();

  private async transaction<T>(action: (tx: GitDirectorDb) => Promise<T>): Promise<T> {
    const owner=ownerRuntimeFor(this.deps.db);
    if(owner){
      if(this.ownedContext.getStore())throw new Error('Nested Git owner transaction');
      const principal=currentNativePrincipal();
      let result!:T;const events:Array<{type:string;payload:Record<string,unknown>}>=[],checks:Array<(snapshot:OwnerStateSnapshot)=>void>=[];
      await mutateOwnerState(owner,{kind:'git.command',payload:{},authorize:snapshot=>{for(const check of checks)check(snapshot);},prepare:async ctx=>{
        this.broadcasts.set(this.deps.db,events);
        try{result=await this.ownedContext.run({ctx,checks},()=>principal?withNativePrincipal(principal,()=>action(this.deps.db)):action(this.deps.db));}
        finally{this.broadcasts.delete(this.deps.db);}
        // Keep the same finite recent-decision projection as bootstrap; history
        // remains durable and is read explicitly by request ID when requested.
        for (const clone of ctx.draft.table('gitClones').all()) {
          const rows=[...ctx.draft.table('gitMergeRequests').by('cloneId',clone.id)].sort((a,b)=>b.requestedAt.localeCompare(a.requestedAt)||b.id.localeCompare(a.id));
          for(const row of rows.slice(25))if(row.completedAt){ctx.draft.remove('gitMergeRequests',row.id);this.evaluatedWaits.delete(row.id);}
        }
        return ()=>JSON.parse(JSON.stringify(result??null)) as Json;
      }});
      for(const event of events)wsPublisher.publish(event.type,event.payload);
      return result;
    }
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result = await this.deps.db.transaction(async (tx) => {
      await lockClaimGate(tx);
      this.broadcasts.set(tx, events);
      try { return await action(tx); } finally { this.broadcasts.delete(tx); }
    });
    // Notices are durable in the transaction; invalidations follow COMMIT.
    for (const event of events) {
      if (event.type === 'git_director.changed') wsPublisher.publish('git_director.changed', event.payload);
      else if (event.type === 'settings.changed') wsPublisher.publish('settings.changed', event.payload);
      else if (event.type === 'agent_messaging.message.changed') wsPublisher.publish('agent_messaging.message.changed', event.payload);
    }
    return result;
  }

  private publish(tx: GitDirectorDb, kind: string, cloneId?: string) {
    this.broadcasts.get(tx)?.push({ type: 'git_director.changed', payload: { kind, ...(cloneId ? { clone_id: cloneId } : {}) } });
  }

  private async notify(tx: GitDirectorDb, event: DirectorEvent) {
    const context=this.ownedContext.getStore()?.ctx;
    if(context){
      const ids=this.deps.notifications?.enqueueOwned(context,ownerRuntimeFor(this.deps.db)!,event,this.now())??[];
      for(const id of ids)this.broadcasts.get(tx)?.push({type:'agent_messaging.message.changed',payload:{message_id:id,status:'queued'}});
      return;
    }
    const ids = await this.deps.notifications?.enqueue(tx, event, this.now()) ?? [];
    for (const id of ids) this.broadcasts.get(tx)?.push({ type: 'agent_messaging.message.changed', payload: { message_id: id, status: 'queued' } });
  }

  private async notificationRevision(db: GitDirectorDb = this.deps.db): Promise<number> {
    const snapshot=this.snapshot(db);if(snapshot)return Number(snapshot.setting('owner_admin_event_id')??0);
    const [row] = await db.select({ id: adminEvents.id }).from(adminEvents)
      .where(eq(adminEvents.type, 'git_director.notifications')).orderBy(desc(adminEvents.id)).limit(1);
    return row?.id ?? 0;
  }

  // ── module switch ─────────────────────────────────────────────────────────

  async getEnabled(): Promise<boolean> {
    return await this.deps.settings.getFlag(GIT_DIRECTOR_ENABLED_FLAG, false);
  }

  async getModel(): Promise<string> {
    const raw = await this.deps.settings.getString(GIT_DIRECTOR_MODEL_KEY, null);
    return raw?.trim() || this.deps.judge?.model || GIT_DIRECTOR_DEFAULT_MODEL;
  }

  async adminState(): Promise<GitDirectorModuleState> {
    const meta = await this.deps.settings.getWithMeta(GIT_DIRECTOR_ENABLED_FLAG);
    const cloneRows = this.rows(this.deps.db,'gitClones')?.filter(row=>!row.archivedAt) ?? await this.deps.db.select({ id: gitClones.id }).from(gitClones).where(isNull(gitClones.archivedAt));
    const worktreeRows = this.rows(this.deps.db,'gitWorktrees') ?? await this.deps.db
      .select({ id: gitWorktrees.id, status: gitWorktrees.status })
      .from(gitWorktrees)
      .where(eq(gitWorktrees.status, 'active'));
    return {
      enabled: await this.getEnabled(),
      model: await this.getModel(),
      clones: cloneRows.length,
      worktrees: worktreeRows.filter((row) => row.status === 'active').length,
      updated_at: meta.updatedAt,
    };
  }

  async setEnabled(enabled: boolean): Promise<GitDirectorModuleState> {
    await this.transaction(async tx => {
      await lockClaimGate(tx);
      const settings = new SettingsService(tx as Database);
      const previous = await settings.getFlag(GIT_DIRECTOR_ENABLED_FLAG, false);
      const context = this.ownedContext.getStore()?.ctx;
      if (context) { const row = {name:GIT_DIRECTOR_ENABLED_FLAG,version:enabled?'1':'0',updatedAt:this.now()}; context.draft.upsert('versions',row); context.write(async db => db.insert(versions).values(row).onDuplicateKeyUpdate({set:{version:row.version,updatedAt:row.updatedAt}})); }
      else await settings.setFlag(GIT_DIRECTOR_ENABLED_FLAG, enabled, { publish: false });
      if (previous !== enabled) await this.notify(tx, { kind: 'module_toggled', audience: 'active', includeActor: true, detail: { enabled, registrations_retained: true, leases_revoked: false, recheck_required: enabled } });
      this.broadcasts.get(tx)?.push({ type: 'settings.changed', payload: { kind: 'git_director', enabled } });
      this.publish(tx, 'state');
    });
    return await this.adminState();
  }

  /** How many live clones this host can see. Used by the AGENTS.md renderer. */
  async availableCount(host: Host | null): Promise<number> {
    const rows = this.rows(this.deps.db, 'gitClones') ?? await this.deps.db
      .select({ id: gitClones.id, hostId: gitClones.hostId, archivedAt: gitClones.archivedAt })
      .from(gitClones);
    return rows.filter((row) => !row.archivedAt && (host === null || row.hostId === host.id)).length;
  }

  // ── expiry sweep ──────────────────────────────────────────────────────────

  /**
   * Reclaim what forgotten clients left behind, and record that it was forgotten
   * rather than finished.
   *
   * An agent that vanishes mid-task is the normal case, not the exception: a
   * closed terminal, a killed wrapper, a rebooted laptop, a session that simply
   * ended. None of those call `git_release`. Left alone, that agent's
   * registration keeps claiming a worktree it no longer occupies, and — far
   * worse — its lease keeps a shared branch shut against everybody else. The
   * first forgotten client that wedges a repository forever is how this feature
   * gets switched off, so reclaiming is a first-class operation rather than
   * cleanup.
   *
   * There are two independent signals, and using only the second is the mistake
   * to avoid:
   *
   *  1. **Definitive death.** When Agent Messaging bound an address to the
   *     registration, `agent_bus_addresses.current_session_id` is NULL exactly
   *     when no wrapper lifecycle is attached — the agent is not running, and no
   *     amount of waiting will bring this one back. That is the same liveness
   *     the fleet already computes for `agent_list`, deliberately reused rather
   *     than reinvented as a second heartbeat, and it reclaims in seconds
   *     instead of waiting out a TTL.
   *  2. **Silence.** With Agent Messaging off there is no address to consult, so
   *     the TTL is the only signal left. It is the fallback, never the primary.
   *
   * Swept on read, at the top of every listing and every decision, like
   * `sweepPinsLocked` in agent-messaging/conference.ts — a timer nobody can observe is
   * worse than work done by whoever next looks.
   *
   * Nothing is deleted. An expired registration keeps its row so `git_list` and
   * the console can still show that somebody WAS here and when they were last
   * seen; a registration that silently disappeared would read as an empty clone,
   * which is a worse lie than a stale one.
   */
  async reconcileOwned(): Promise<void> {
    if (!this.snapshot()) return;
    await this.sweepForRead(this.now());
  }
  private waitInputs(request: GitMergeRequest): string {
    const snapshot=this.snapshot()!;
    return JSON.stringify([snapshot.table('gitWorktrees').by('cloneId',request.cloneId),snapshot.table('gitMergeRequests').by('cloneId',request.cloneId),snapshot.table('agentResourceClaims').all()]);
  }
  private async sweepForRead(now: string): Promise<void> {
    if (await this.sweepExpired(this.deps.db, now, false)) {
      await this.transaction(tx => this.sweepExpired(tx, now));
    }
  }

  private async sweepExpired(db: GitDirectorDb, now: string, apply = true): Promise<boolean> {
    const snapshot = this.snapshot(db);
    if (snapshot) {
      const uncertain = snapshot.table('gitWorktrees').by('status', 'active').filter(row => !this.registrationProof(row, snapshot));
      const expired = snapshot.table('gitMergeRequests').by('verdict', 'allow').filter(row => !row.completedAt && isExpired(row.leaseExpiresAt, now));
      if (!apply) return Boolean(uncertain.length || expired.length);
      for (const row of uncertain) {
        await this.updateRows(db, 'gitWorktrees', [row.id], { status: 'uncertain', uncertaintyReason: 'disconnected', updatedAt: now });
        this.publish(db, 'worktree', row.cloneId);
      }
      for (const row of expired) {
        await this.updateRows(db, 'gitMergeRequests', [row.id], { verdict: 'expired', completedAt: now, updatedAt: now });
        await this.notify(db, { kind: 'lease_expired', clone: snapshot.table('gitClones').get(row.cloneId), requestId: row.id, targetBranch: row.targetBranch, audience: 'branch' });
        this.publish(db, 'lease', row.cloneId);
      }
      return Boolean(uncertain.length || expired.length);
    }
    const active = (
      await db
        .select()
        .from(gitWorktrees)
        .where(eq(gitWorktrees.status, 'active'))
    ).filter((row) => row.status === 'active');

    const dead = await this.deadAddressIds(
      db,
      active.map((row) => row.agentBusAddressId).filter((id): id is string => Boolean(id)),
      now,
    );

    const abandoned = active.filter(
      (row) => row.agentBusAddressId !== null && dead?.has(row.agentBusAddressId),
    );
    // TTL only bites where there is no address to ask or presence is unavailable.
    // A live bound agent must not be evicted for being quiet between calls.
    const timedOut = active.filter(
      (row) => (row.agentBusAddressId === null || dead === null) && isExpired(row.expiresAt, now),
    );

    const reclaimedWorktrees = new Set([...abandoned, ...timedOut].map((row) => row.id));

    const liveLeases = (
      await db
        .select()
        .from(gitMergeRequests)
        .where(eq(gitMergeRequests.verdict, 'allow'))
    ).filter((row) => row.verdict === 'allow' && !row.completedAt);

    // A lease whose holder is gone is released with the holder, without waiting
    // out its own TTL. This is the case that actually hurts: everyone else on
    // that branch is blocked behind an agent that no longer exists.
    const orphaned = liveLeases.filter((row) => reclaimedWorktrees.has(row.worktreeId));
    const staleLeases = liveLeases.filter(
      (row) => !reclaimedWorktrees.has(row.worktreeId) && isExpired(row.leaseExpiresAt, now),
    );

    const changed = abandoned.length + timedOut.length + orphaned.length + staleLeases.length > 0;
    if (!apply) return changed;
    if (abandoned.length > 0) {
      await this.updateRows(db, 'gitWorktrees', abandoned.map((row) => row.id), { status: 'abandoned', releasedAt: now, updatedAt: now });
    }
    if (timedOut.length > 0) {
      await this.updateRows(db, 'gitWorktrees', timedOut.map((row) => row.id), { status: 'expired', releasedAt: now, updatedAt: now });
    }

    if (orphaned.length > 0) {
      await this.updateRows(db, 'gitMergeRequests', orphaned.map((row) => row.id), {
          verdict: 'expired',
          completedAt: now,
          reason: 'Lease reclaimed: the holding agent is no longer registered in this clone.',
          updatedAt: now,
        });
    }
    if (staleLeases.length > 0) {
      await this.updateRows(db, 'gitMergeRequests', staleLeases.map((row) => row.id), {
          verdict: 'expired',
          completedAt: now,
          reason: 'Lease expired: it was never renewed with git_merge_status and never released.',
          updatedAt: now,
        });
    }
    for (const worktree of [...abandoned, ...timedOut]) {
      const [clone] = (this.rows(db, 'gitClones')?.filter(row => row.id === worktree.cloneId) ?? await db.select().from(gitClones).where(eq(gitClones.id, worktree.cloneId)));
      this.publish(db, 'expiry', worktree.cloneId);
      await this.notify(db, { kind: abandoned.includes(worktree) ? 'registration_abandoned' : 'registration_expired', clone, worktree, audience: 'branch', includeActor: true, detail: { recheck_required: true } });
    }
    for (const request of [...orphaned, ...staleLeases]) {
      const [clone] = (this.rows(db, 'gitClones')?.filter(row => row.id === request.cloneId) ?? await db.select().from(gitClones).where(eq(gitClones.id, request.cloneId)));
      const [worktree] = (this.rows(db, 'gitWorktrees')?.filter(row => row.id === request.worktreeId) ?? await db.select().from(gitWorktrees).where(eq(gitWorktrees.id, request.worktreeId)));
      this.publish(db, 'expiry', request.cloneId);
      await this.notify(db, { kind: 'lease_expired', clone, worktree, targetBranch: request.targetBranch, requestId: request.id, audience: 'branch', includeActor: true, detail: { recheck_required: true } });
    }
    return changed;
  }

  /**
   * Which of these bound addresses no longer have a live agent behind them.
   *
   * This asks the fleet's own liveness rather than adding a heartbeat the
   * Director would have to keep accurate on its own — but it asks the *derived*
   * answer, not the stored one. `readiness` alone said a peer was alive for as
   * long as its row survived, because for a session that never calls
   * `agent_listen` the column is written once at registration and not again
   * until finish. A crashed agent therefore held a shared branch until its
   * binding was reaped on `bridge_expires_at` — 900s, restamped every 15s, so
   * roughly a quarter hour. Deriving from the session heartbeat reclaims it
   * inside one freshness window instead.
   *
   * Failing open is deliberate: if the Agent Messaging tables cannot be read —
   * a box mid-deploy, the module never installed — no address is reported dead
   * and every registration falls back to its TTL. Guessing "dead" on a failed
   * read would evict live agents wholesale.
   */
  private async deadAddressIds(db: GitDirectorDb, ids: readonly string[], now: string): Promise<Set<string> | null> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    try {
      const rows = await db
        .select({
          id: agentBusAddresses.id,
          currentSessionId: agentBusAddresses.currentSessionId,
          bindingGeneration: agentBusAddresses.bindingGeneration,
          lastUpstreamSessionId: agentBusAddresses.lastUpstreamSessionId,
          receiveHeartbeatAt: agentBusAddresses.receiveHeartbeatAt,
          enabled: agentBusAddresses.enabled,
          archivedAt: agentBusAddresses.archivedAt,
          readiness: agentBusAddresses.readiness,
          // Left, not inner: a reaped binding has no session row, and that
          // absence is the answer rather than a reason to drop the address.
          session: { heartbeatAt: agentSessions.heartbeatAt, endedAt: agentSessions.endedAt, workspace: agentSessions.workspace },
        })
        .from(agentBusAddresses)
        .leftJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
        .where(inArray(agentBusAddresses.id, unique))
        .limit(Math.max(unique.length, 1));
      const known = new Map(rows.map((row) => [row.id, row]));
      // From the sweep's own clock, not wall time: `sweepExpired` is driven by
      // an injectable `now`, and a freshness window that ignored it would make
      // this branch untestable at the exact boundary it exists to enforce.
      const freshAfter = isoOffsetSeconds(
        -(this.deps.freshSeconds ?? AGENT_PRESENCE_FRESH_SECONDS),
        parseIso(now) ?? new Date(),
      );
      const dead = new Set<string>();
      for (const id of unique) {
        const row = known.get(id);
        // An id we bound and can no longer find has been purged; that is gone too.
        if (!row) {
          dead.add(id);
          continue;
        }
        if (!isPresent(deriveAddressPresence(row, row.session, freshAfter))) dead.add(id);
      }
      return dead;
    } catch {
      return null;
    }
  }

  // ── registration ──────────────────────────────────────────────────────────

  /**
   * Announce this worktree. Idempotent on (clone, worktree path).
   *
   * Re-registration under a different username or agent is the NORMAL case —
   * crash and restart, or two shells in one directory — so this is
   * last-writer-wins and reports `rebound: true` rather than refusing. It
   * deliberately does not copy `assertAddressRegistration`'s ForbiddenError from
   * agent-messaging.ts: that strictness protects a durable message queue bound to
   * an address, a worktree registration has no queue, and throwing would lock a
   * restarted agent out of its own directory until the TTL expired.
   *
   * The one refusal: a live registration that currently holds a merge lease. A
   * lease must never change hands by re-registering.
   */
  async register(args: Record<string, unknown>, host: Host, provenance?: GitProvenance): Promise<Record<string, unknown>> {
    const now = this.now();
    const worktreePath = normalizePath(requiredString(args, 'worktree_path'));
    let cloneDir = normalizePath(optionalString(args, 'clone_dir') ?? worktreePath);
    const repoRoot = normalizePath(optionalString(args, 'repo_root') ?? worktreePath);
    for (const [param, path] of Object.entries({
      worktree_path: worktreePath,
      clone_dir: cloneDir,
      repo_root: repoRoot,
    })) {
      if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
        throw new ValidationError(`${param} must be absolute; use git rev-parse --path-format=absolute`, {
          param,
        });
      }
    }
    const remoteUrl = optionalString(args, 'remote_url');
    const branch = optionalString(args, 'branch', 255);
    const headSha = optionalString(args, 'head_sha', 64);
    const requestedUsername = optionalString(args, 'username', 255);
    const engineRaw = optionalString(args, 'engine', 16);
    const engine = isEngine(engineRaw) ? engineRaw : null;

    const worktreeHash = sha256(worktreePath);
    const remoteKey = normalizeRemote(remoteUrl);

    return await this.transaction(async (tx) => {
      await lockClaimGate(tx);
      await this.sweepExpired(tx, now);
      // Serialize path reassignment across different clones on the same host.
      if (!this.snapshot(tx)) await tx.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, host.id)).for('update');

      // A refresh may omit clone_dir. Preserve the existing canonical mapping;
      // the server cannot discover a remote checkout's common directory itself.
      if (args.clone_dir === undefined) {
        const view = this.snapshot(tx);
        const mappings = view ? view.table('gitWorktrees').all().filter(row => row.hostId === host.id && row.worktreeHash === worktreeHash && row.status !== 'superseded').flatMap(row => { const clone = view.table('gitClones').get(row.cloneId); return clone && !clone.archivedAt ? [{clone}] : []; }) : await tx.select({ clone: gitClones }).from(gitWorktrees)
          .innerJoin(gitClones, eq(gitWorktrees.cloneId, gitClones.id))
          .where(and(eq(gitWorktrees.hostId, host.id), eq(gitWorktrees.worktreeHash, worktreeHash),
            ne(gitWorktrees.status, 'superseded'), isNull(gitClones.archivedAt)));
        const dirs = [...new Set(mappings.map((r) => r.clone.cloneDir))];
        if (dirs.length > 1) throw new ConflictError('Multiple clone mappings exist; pass the absolute clone_dir from git rev-parse --git-common-dir', 'git_director_worktree_ambiguous');
        if (dirs[0]) cloneDir = dirs[0];
      }
      const clone = await this.upsertCloneLocked(tx, {
        host,
        cloneKey: sha256(cloneDir),
        cloneDir,
        repoRoot,
        remoteUrl,
        remoteKey: remoteKey ? sha256(remoteKey) : null,
        now,
      });

      const registrations = (
        this.rows(tx, 'gitWorktrees') ?? await tx
          .select()
          .from(gitWorktrees)
          .where(and(eq(gitWorktrees.hostId, host.id), eq(gitWorktrees.worktreeHash, worktreeHash)))
          .for('update')
      ).filter((row) => row.hostId === host.id && row.worktreeHash === worktreeHash);
      const superseded = registrations.filter((row) => row.cloneId !== clone.id && row.status !== 'superseded');
      for (const row of superseded) {
        if (this.snapshot(tx) && ['active','uncertain'].includes(row.status)) throw new ConflictError('Existing clone mapping retains exclusion; unregister it explicitly first', 'git_director_owner_uncertain');
        if (await this.liveLeaseForWorktree(tx, row.id, now)) {
          throw new ConflictError(
            'This path is registered under another clone with a live merge lease; release that lease first.',
            'git_director_lease_held',
          );
        }
      }
      const supersededRegistrations: Array<{ worktree_id: string; withdrawn_request_ids: string[] }> = [];
      for (const row of superseded) {
        const pending = await this.liveRequestsForWorktree(tx, row.id, now);
        if (pending.length)
          await this.updateRows(tx, 'gitMergeRequests', pending.map((request) => request.id), { verdict: 'withdrawn', reason: 'Withdrawn by git_release or superseding registration; merge outcome is unknown.', completedAt: now, updatedAt: now });
        await this.updateRows(tx, 'gitWorktrees', [row.id], { status: 'superseded', releasedAt: now, updatedAt: now });
        supersededRegistrations.push({ worktree_id: row.id, withdrawn_request_ids: pending.map(r => r.id) });
        this.publish(tx, 'worktree', row.cloneId);
        const previousClone = this.snapshot(tx) ? this.snapshot(tx)!.table('gitClones').get(row.cloneId) : (await tx.select().from(gitClones).where(eq(gitClones.id,row.cloneId)))[0];
        await this.notify(tx, { kind: 'registration_superseded', clone: previousClone, worktree: row, audience: 'branch', includeActor: true, detail: { withdrawn_requests: pending.map(r => r.id) } });
      }

      const address = provenance
        ? remoteAddress((await remoteGitOwner(tx, provenance, this.snapshot(tx))).session)
        : await this.resolveAddress(tx, host, requestedUsername, engine, worktreePath, now);
      const username = requestedUsername ?? address?.username ?? 'unknown';
      const owner = ownerRuntimeFor(tx), state = this.snapshot(tx);
      const session = address ? state?.sessions.get(address.sessionId) : undefined;
      const attachment = owner && session ? nativeClaimAttachment(owner, session) : undefined;
      const existing = (
        this.rows(tx, 'gitWorktrees') ?? await tx
          .select()
          .from(gitWorktrees)
          .where(and(eq(gitWorktrees.cloneId, clone.id), eq(gitWorktrees.worktreeHash, worktreeHash)))
          .limit(1)
          .for('update')
      ).find((row) => row.cloneId === clone.id && row.worktreeHash === worktreeHash);

      if (owner && existing?.ownershipMode === 'timed' && ['active','uncertain'].includes(existing.status)) {
        if (!session || existing.agentSessionId !== session.id || existing.agentBindingGeneration !== session.bindingGeneration ||
            !['active', 'uncertain'].includes(existing.status) ||
            (existing.status === 'uncertain' && !['owner_restart', 'disconnected'].includes(existing.uncertaintyReason ?? ''))) {
          throw new ConflictError('Only the captured pre-cutover owner may report this registration', 'git_director_owner_uncertain');
        }
        this.requireRegistrationProof(existing);
        const patch = { branch: branch ?? existing.branch, headSha: headSha ?? existing.headSha,
          headObservedAt: headSha ? now : existing.headObservedAt, status: 'active', uncertaintyReason: null };
        if (patch.branch !== existing.branch || patch.headSha !== existing.headSha || existing.status !== 'active') {
          await this.updateRows(tx, 'gitWorktrees', [existing.id], { ...patch, updatedAt: now });
          this.publish(tx, 'worktree', clone.id);
        }
        return { registered: true, superseded_registrations: supersededRegistrations, rebound: false,
          clone: this.cloneWire(clone,host), worktree_id: existing.id, worktree_path: worktreePath,
          ...bindingWire(address), expires_at: this.registrationExpiresAt(existing), ownership_mode: 'timed',
          presence_source: 'legacy_drain', peers: await this.peerWire(tx,clone.id,existing.id,now) };
      }
      if (owner && (!session || !attachment)) throw nativeRegistrationRequired('A current native instance attachment is required for registration');
      if (owner && session && attachment) this.ownedContext.getStore()!.checks.push(snapshot => { const current=snapshot.sessions.get(session.id); if (!current || current.endedAt || current.bindingGeneration!==session.bindingGeneration || !nativeClaimAttachment(owner,current,attachment.scope.native_instance_id)) throw new ConflictError('Native instance disconnected before registration commit','git_director_owner_uncertain'); });
      const ownership = owner ? { ownershipMode: 'connection', nativeInstanceId: attachment!.scope.native_instance_id!, uncertaintyReason: null } : {};

      const expiresAt = isoOffsetSeconds(REGISTRATION_TTL_SECONDS, new Date(now));
      if (!existing) {
        const id = randomUUID();
        await this.insertRow(tx, 'gitWorktrees', {
          id,
          ...ownership,
          cloneId: clone.id,
          hostId: host.id,
          worktreePath,
          worktreeHash,
          username,
          engine,
          agentBusAddressId: address?.id ?? null,
          agentSessionId: address?.sessionId ?? null,
          agentBindingGeneration: address?.generation ?? null,
          branch,
          headSha,
          headObservedAt: headSha ? now : null,
          task: null,
          declaredPaths: null,
          targetBranch: null,
          status: 'active',
          registeredAt: now,
          heartbeatAt: now,
          expiresAt,
          releasedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        this.publish(tx, 'worktree', clone.id);
        return {
          registered: true,
          superseded_registrations: supersededRegistrations,
          rebound: false,
          clone: this.cloneWire(clone, host),
          worktree_id: id,
          worktree_path: worktreePath,
          ...bindingWire(address),
          expires_at: owner ? null : expiresAt, ownership_mode: owner ? 'connection' : 'timed', presence_source: 'connection',
          peers: await this.peerWire(tx, clone.id, id, now),
        };
      }

      const resume = owner && state && session && existing?.ownershipMode === 'connection' &&
        existing.status === 'uncertain' && existing.agentSessionId && existing.agentBindingGeneration !== null && existing.nativeInstanceId &&
        ['owner_restart','disconnected'].includes(existing.uncertaintyReason ?? '') &&
        resumedNativeAttachment(owner,state,existing.agentSessionId,existing.agentBindingGeneration,session);
      if (resume && owner && session && existing?.agentSessionId && existing.agentBindingGeneration !== null) {
        const previousId = existing.agentSessionId, previousGeneration = existing.agentBindingGeneration;
        this.ownedContext.getStore()!.checks.push(snapshot => {
          if (!resumedNativeAttachment(owner,snapshot,previousId,previousGeneration,session))
            throw new ConflictError('Native continuation proof changed','git_director_owner_uncertain');
        });
      }
      if (owner && existing && ['active','uncertain'].includes(existing.status) && !resume && (existing.agentSessionId !== session!.id || existing.agentBindingGeneration !== session!.bindingGeneration || existing.nativeInstanceId !== attachment!.scope.native_instance_id)) throw new ConflictError('Existing registration retains exclusion until its original owner releases it', 'git_director_owner_uncertain');
      const rebound =
        existing.username !== username ||
        (address?.id ?? null) !== (existing.agentBusAddressId ?? null) ||
        (existing.agentSessionId != null && (address?.sessionId ?? null) !== existing.agentSessionId) ||
        (existing.agentBindingGeneration != null && (address?.generation ?? null) !== existing.agentBindingGeneration);
      if (rebound && existing.status === 'active') {
        const lease = await this.liveLeaseForWorktree(tx, existing.id, now);
        if (lease) {
          throw new ConflictError(
            'That worktree is registered to another live agent and currently holds a merge lease; ' +
              'have the holder call git_release, or wait for the lease to expire.',
            'git_director_lease_held',
          );
        }
      }

      const reboundRequests = rebound ? await this.liveRequestsForWorktree(tx, existing.id, now) : [];
      if (reboundRequests.length) await this.updateRows(tx, 'gitMergeRequests', reboundRequests.map(r => r.id), { verdict: 'withdrawn', reason: 'Withdrawn: registration owner binding changed.', completedAt: now, updatedAt: now });
      await this.updateRows(tx, 'gitWorktrees', [existing.id], {
          ...ownership,
          username,
          engine,
          agentBusAddressId: address?.id ?? null,
          agentSessionId: address?.sessionId ?? null,
          agentBindingGeneration: address?.generation ?? null,
          branch,
          headSha,
          headObservedAt: headSha ? now : null,
          worktreePath,
          status: 'active',
          heartbeatAt: now,
          expiresAt,
          releasedAt: null,
          updatedAt: now,
        });
      this.publish(tx, 'worktree', clone.id);
      if (resume) this.ownedContext.getStore()!.ctx.write(owned => persistAuditLog(owned, { hostId: host.id, engine, action: 'git_registration.resumed', details: JSON.stringify({ worktree_id: existing.id, previous_session_id: existing.agentSessionId, session_id: session!.id, withdrawn_request_ids: reboundRequests.map(r => r.id) }), createdAt: now }));
      if (rebound) await this.notify(tx, { kind: 'registration_rebound', clone, worktree: existing, audience: 'owners', includeActor: true, detail: { withdrawn_request_ids: reboundRequests.map(r => r.id) } });
      return {
        registered: true,
        superseded_registrations: supersededRegistrations,
        rebound,
        withdrawn_request_ids: reboundRequests.map(r => r.id),
        clone: this.cloneWire(clone, host),
        worktree_id: existing.id,
        worktree_path: worktreePath,
        ...bindingWire(address),
        expires_at: owner ? null : expiresAt, ownership_mode: owner ? 'connection' : 'timed', presence_source: 'connection',
        peers: await this.peerWire(tx, clone.id, existing.id, now),
      };
    });
  }

  /**
   * Declare intent against an already-registered worktree: what you are about to
   * change and where you mean to merge it. Register is physical presence; join is
   * the plan. `paths` is what makes a later `wait` specific instead of a mutex.
   */
  async join(args: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const now = this.now();
    const worktreePath = normalizePath(requiredString(args, 'worktree_path'));
    const task = optionalString(args, 'task', MAX_TASK_LENGTH);
    const targetBranch = optionalString(args, 'target_branch', 255);
    const paths = args.paths === undefined ? undefined : cleanPaths(args.paths);

    return await this.transaction(async (tx) => {
      await lockClaimGate(tx);
      await this.sweepExpired(tx, now);
      const { clone, worktree } = await this.requireWorktree(tx, host, worktreePath, now);
      const expiresAt = isoOffsetSeconds(REGISTRATION_TTL_SECONDS, new Date(now));
      await this.updateRows(tx, 'gitWorktrees', [worktree.id], {
          task: task ?? worktree.task,
          targetBranch: targetBranch ?? worktree.targetBranch,
          declaredPaths: paths ?? worktree.declaredPaths,
          status: 'active',
          ...(this.snapshot(tx) ? {} : { heartbeatAt: now, expiresAt }),
          updatedAt: now,
        });
      this.publish(tx, 'worktree', clone.id);
      const previousPaths = readPaths(worktree.declaredPaths).sort();
      const nextPaths = [...(paths ?? previousPaths)].sort();
      const nextTarget = targetBranch ?? worktree.targetBranch;
      const peerOverlap = peerDeclarationOverlap(nextPaths, await this.livePeerDeclarations(tx, clone.id, [worktree.id], nextTarget ?? '', now));
      if (nextTarget !== worktree.targetBranch || JSON.stringify(nextPaths) !== JSON.stringify(previousPaths)) {
        const previousOverlap = peerDeclarationOverlap(previousPaths, await this.livePeerDeclarations(tx, clone.id, [worktree.id], worktree.targetBranch ?? '', now));
        await this.notify(tx, { kind: 'work_scope_changed', clone, worktree, targetBranch: nextTarget, previousTargetBranch: worktree.targetBranch, audience: 'repository', detail: { previous_paths: previousPaths, paths: nextPaths, previous_peer_overlap: previousOverlap, peer_overlap: peerOverlap } });
      }
      return {
        joined: true,
        peer_overlap: peerOverlap,
        clone: this.cloneWire(clone, host),
        worktree_id: worktree.id,
        task: task ?? worktree.task,
        target_branch: targetBranch ?? worktree.targetBranch,
        declared_paths: paths ?? readPaths(worktree.declaredPaths),
        expires_at: this.snapshot(tx) ? this.registrationExpiresAt(worktree) : expiresAt,
        peers: await this.peerWire(tx, clone.id, worktree.id, now),
      };
    });
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  /**
   * What is going on. Host-scoped by default because that is the question an
   * agent actually has ("who else is in my checkout"); `fleet` widens it to every
   * host, and `clone` narrows to one. The reply is a compact summary page by
   * default (`detail: "full"` restores every worktree, lease and stale row;
   * `limit`/`offset` page through clones, with `truncated` and `next_offset`).
   */
  async list(args: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const now = this.now();
    const scopeRaw = String(args.scope ?? 'host').trim().toLowerCase();
    const scope = scopeRaw === 'fleet' || scopeRaw === 'clone' ? scopeRaw : 'host';
    const worktreePath = optionalString(args, 'worktree_path');
    // The Director never reads a worktree, so the HEAD it lists is only ever
    // what the agent last said. A heartbeat may carry a fresh report; without
    // one the stored head_sha and its head_observed_at stay exactly as they were
    // rather than being silently re-stamped as if re-observed.
    const reportedHead = optionalString(args, 'head_sha', 64);
    const reportedBranch = optionalString(args, 'branch', 255);

    // Watching counts as working. An agent that polls git_list to see whether a
    // peer has appeared is plainly still alive, and reaping it for "going quiet"
    // while it is looking straight at us would be the exact failure this feature
    // is supposed to prevent. Heartbeat first, THEN sweep, so the refresh cannot
    // lose a race with the reaper it is meant to outrun. Any scope: an agent
    // asking a fleet-wide question is no less present than one asking about its
    // own clone.
    if (worktreePath && (!this.snapshot() || reportedHead || reportedBranch)) {
      const normalized = normalizePath(worktreePath);
      try {
        await this.transaction(async (tx) => {
      await lockClaimGate(tx);
          const { clone, worktree } = await this.requireWorktree(tx, host, normalized, now);
          if (reportedHead || reportedBranch) {
            await this.updateRows(tx, 'gitWorktrees', [worktree.id], {
                ...(reportedHead ? { headSha: reportedHead, headObservedAt: now } : {}),
                ...(reportedBranch ? { branch: reportedBranch } : {}),
                updatedAt: now,
              });
            if (reportedBranch && reportedBranch !== worktree.branch) this.publish(tx, 'worktree', clone.id);
          }
        });
      } catch (error) {
        if (error instanceof ConflictError && error.code === 'git_director_worktree_ambiguous') throw error;
        // An unregistered path is not an error here — git_list is how an agent
        // looks around BEFORE it registers, and refusing that would invert the
        // order the guidance tells it to work in.
      }
    }

    await this.sweepForRead(now);

    const allClones = this.rows(this.deps.db, 'gitClones') ?? await this.deps.db.select().from(gitClones);
    const hostRows = this.snapshot()?.hosts.all() ?? await this.deps.db.select({ id: hosts.id, fqdn: hosts.fqdn }).from(hosts);
    const fqdnById = new Map(hostRows.map((row) => [row.id, row.fqdn]));

    let clones = allClones.filter((row) => !row.archivedAt);
    if (scope === 'host') clones = clones.filter((row) => row.hostId === host.id);
    if (scope === 'clone') {
      if (!worktreePath) {
        throw new ValidationError('worktree_path is required when scope is "clone"', {
          param: 'worktree_path',
        });
      }
      const owning = await this.cloneForWorktree(this.deps.db, host, normalizePath(worktreePath));
      clones = owning ? [owning] : [];
    }
    clones.sort((a, b) => a.lastSeenAt < b.lastSeenAt ? 1 : -1);

    // Summary by default, full on request. A narrowed `clone` scope is one
    // checkout the caller named, so it keeps the full entry unless told otherwise.
    const detailRaw = String(args.detail ?? '').trim().toLowerCase();
    const detail = detailRaw === 'full' || detailRaw === 'summary' ? detailRaw : scope === 'clone' ? 'full' : 'summary';
    const limit = listInt(args.limit, 1, LIST_MAX_LIMIT, detail === 'full' ? LIST_MAX_LIMIT : LIST_SUMMARY_DEFAULT_LIMIT);
    const offset = listInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    // The caller's own checkout leads the page, so the pre-work question is
    // answered on page one however many clones the host has.
    if (worktreePath && scope !== 'clone') {
      const own = await this.cloneForWorktree(this.deps.db, host, normalizePath(worktreePath));
      const at = own ? clones.findIndex((row) => row.id === own.id) : -1;
      if (at > 0) clones.unshift(...clones.splice(at, 1));
    }

    const total = clones.length;
    const out: Array<Record<string, unknown>> = [];
    for (const clone of clones.slice(offset, offset + limit)) {
      const entry = {
        ...this.cloneWire(clone, null),
        fqdn: fqdnById.get(clone.hostId) ?? null,
        worktrees: await this.worktreeWire(this.deps.db, clone.id, now),
        leases: await this.leaseWire(this.deps.db, clone.id, now),
        stale: await this.staleWire(this.deps.db, clone.id, now),
      };
      out.push(detail === 'full' ? entry : summarizeCloneEntry(entry));
    }
    const truncated = offset + out.length < total;
    return {
      scope,
      detail,
      coordination_revision: await this.notificationRevision(),
      clones: out,
      count: out.length,
      total,
      offset,
      limit,
      truncated,
      next_offset: truncated ? offset + out.length : null,
    };
  }

  // ── the arbiter ───────────────────────────────────────────────────────────

  /**
   * Ask to merge. Returns a verdict and, when granted, the lease itself.
   *
   * `client_request_id` is the retry guard, not decoration: MCP tool calls get
   * retried and models re-call tools on ambiguous results, so without it a retry
   * mints a second queued row for the same worktree — inflating queue depth and
   * showing the arbiter a contender that does not exist. A repeat returns the
   * original row and its current verdict.
   */
  async requestMerge(args: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const now = this.now();
    const worktreePath = normalizePath(requiredString(args, 'worktree_path'));
    const targetBranch = requiredString(args, 'target_branch', 255);
    const clientRequestId = requiredString(args, 'client_request_id', 191);
    const baseSha = optionalString(args, 'base_sha', 64);
    const headSha = optionalString(args, 'head_sha', 64);
    const changedPaths = cleanPaths(args.changed_paths);

    return await this.decideAndRecord({
      host,
      now,
      worktreePath,
      targetBranch,
      clientRequestId,
      baseSha,
      headSha,
      changedPaths,
    });
  }

  /**
   * Decide one merge request and write the outcome.
   *
   * Shared by `requestMerge` (which inserts a new row) and `mergeStatus`
   * (which re-decides an existing `wait` **in place**, via `updateRequestId`).
   * Polling used to insert a fresh row per call, which was wrong twice over: the
   * caller's `request_id` changed underneath them, and every poll counted as
   * another queued contender — so the queue the arbiter was shown grew the
   * longer somebody waited, describing a crowd that did not exist.
   */
  private async decideAndRecord(input: {
    host: Host;
    now: string;
    worktreePath: string;
    targetBranch: string;
    clientRequestId: string;
    baseSha: string | null;
    headSha: string | null;
    changedPaths: string[];
    updateRequestId?: string;
  }): Promise<Record<string, unknown>> {
    const { host, worktreePath, targetBranch, clientRequestId, baseSha, headSha, changedPaths } = input;
    const now = input.now;
    const updateRequestId = input.updateRequestId ?? null;

    const decision = await this.transaction(async (tx) => {
      await lockClaimGate(tx);
      await this.sweepExpired(tx, now);
      const observedRequest = updateRequestId === null ? null : await this.requireRequest(tx, updateRequestId, host);
      // A release/operator decision may have won after mergeStatus read wait.
      if (observedRequest && (observedRequest.completedAt || observedRequest.verdict !== 'wait'))
        return { request: observedRequest, replayed: true as const, brief: null };
      const { clone, worktree } = await this.requireWorktree(tx, host, worktreePath, now);
      await guardGitMutation(tx, clone, worktree, targetBranch, changedPaths, this.snapshot(tx));
      if (this.snapshot(tx)) this.requireRegistrationProof(worktree);

      // Skipped when re-deciding: the row we are about to update carries this
      // very `client_request_id`, so the retry guard would find itself and
      // short-circuit into "replayed" — a poll that could never change its own
      // verdict.
      let replay = updateRequestId !== null ? undefined : (
        this.rows(tx, 'gitMergeRequests') ?? await tx
          .select()
          .from(gitMergeRequests)
          .where(
            and(
              eq(gitMergeRequests.worktreeId, worktree.id),
              eq(gitMergeRequests.clientRequestId, clientRequestId),
            ),
          )
          .limit(1)
      ).find(
        (row) => row.worktreeId === worktree.id && row.clientRequestId === clientRequestId,
      );
      if (!replay && updateRequestId === null && this.snapshot(tx)) replay = (await this.deps.db.select().from(gitMergeRequests).where(and(eq(gitMergeRequests.worktreeId,worktree.id),eq(gitMergeRequests.clientRequestId,clientRequestId))).limit(1))[0];
      if (replay) {
        return { clone, worktree, request: replay, replayed: true as const, brief: null as MergeBrief | null };
      }

      // Lock the clone row: this is what makes the lease exclusive. MySQL has no
      // partial unique index, and this codebase uses row locks rather than
      // advisory locks everywhere else.
      if (!this.snapshot(tx)) await tx.select().from(gitClones).where(eq(gitClones.id, clone.id)).limit(1).for('update');

      const holderRow = await this.liveLeaseForClone(tx, clone.id, targetBranch, now);
      const queued = await this.queuedForClone(tx, clone.id, targetBranch, now, updateRequestId);
      const holderWorktree = holderRow
        ? ((this.rows(tx, 'gitWorktrees')?.filter(row => row.id === holderRow.worktreeId) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, holderRow.worktreeId)).limit(1))).find(
            (row) => row.id === holderRow.worktreeId,
          ) ?? null
        : null;

      const holderPaths = holderRow
        ? [...readPaths(holderRow.changedPaths), ...readPaths(holderWorktree?.declaredPaths)]
        : [];
      const overlap = overlappingPaths(changedPaths, holderPaths);
      const contended = Boolean(holderRow) || overlap.length > 0;

      const brief: MergeBrief | null = contended
        ? {
            target_branch: targetBranch,
            requester: {
              worktree_path: worktree.worktreePath,
              branch: worktree.branch,
              username: worktree.username,
              task: worktree.task,
              held_for_seconds: null,
            },
            holder: holderWorktree
              ? {
                  worktree_path: holderWorktree.worktreePath,
                  branch: holderWorktree.branch,
                  username: holderWorktree.username,
                  task: holderWorktree.task,
                  held_for_seconds: secondsBetween(holderRow?.decidedAt ?? null, now),
                }
              : null,
            overlap,
            requester_path_count: changedPaths.length,
            queue_depth: queued.length,
          }
        : null;

      void contended;
      return { clone, worktree, observedRequest, request: null, replayed: false as const, brief };
    });

    if (decision.replayed) {
      return this.requestWire(decision.request, { replayed: true });
    }

    // The judge runs OUTSIDE the row lock. A model call can take seconds, and
    // holding a clone-wide lock across it would serialize every unrelated
    // request on the same repo behind one inference.
    let judged: JudgeVerdict | null = null;
    let model: string | null = null;
    if (decision.brief) {
      const judge = this.deps.judge;
      if (judge) {
        model = await this.getModel();
        try {
          judged = normalizeJudgeVerdict(await judge.judge(decision.brief));
        } catch {
          judged = null;
        }
      }
    }

    return await this.transaction(async (tx) => {
      await lockClaimGate(tx);
      const now2 = this.now();
      const [clone] = (this.rows(tx, 'gitClones')?.filter(row => row.id === decision.clone.id) ?? await tx.select().from(gitClones).where(eq(gitClones.id, decision.clone.id)).limit(1).for('update'));
      if (!clone || clone.archivedAt || clone.hostId !== host.id || clone.cloneDir !== decision.clone.cloneDir)
        throw new ConflictError('Clone changed while the merge was being judged', 'git_director_clone_changed');
      const existing = updateRequestId === null
        ? (this.rows(tx, 'gitMergeRequests') ?? await tx.select().from(gitMergeRequests).where(and(
          eq(gitMergeRequests.worktreeId, decision.worktree.id),
          eq(gitMergeRequests.clientRequestId, clientRequestId),
        )).limit(1)).find((row) => row.worktreeId === decision.worktree.id && row.clientRequestId === clientRequestId) ?? null
        : await this.requireRequest(tx, updateRequestId, host);
      // The arbiter ran without locks. Never overwrite a newer decision (even
      // a nonterminal operator allow/wait), or renew a retried grant by accident.
      if (existing && (updateRequestId === null || JSON.stringify(existing) !== JSON.stringify(decision.observedRequest)))
        return this.requestWire(existing, { replayed: true }, tx);
      const [worktree] = (this.rows(tx, 'gitWorktrees')?.filter(row => row.id === decision.worktree.id) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, decision.worktree.id)));
      if (!worktree || worktree.status !== 'active' || worktree.cloneId !== clone.id || worktree.worktreePath !== worktreePath ||
        (this.snapshot(tx) ? !this.registrationProof(worktree) : !(Date.parse(worktree.expiresAt) > Date.parse(now2))) ||
        worktree.username !== decision.worktree.username || worktree.engine !== decision.worktree.engine ||
        worktree.agentBusAddressId !== decision.worktree.agentBusAddressId ||
        worktree.agentSessionId !== decision.worktree.agentSessionId ||
        worktree.agentBindingGeneration !== decision.worktree.agentBindingGeneration)
        throw new ConflictError('Worktree changed while the merge was being judged', 'git_director_worktree_changed');
      await guardGitMutation(tx, clone, worktree, targetBranch, changedPaths, this.snapshot(tx));
      if (this.snapshot(tx)) this.requireRegistrationProof(worktree);

      // Re-read under the lock: the holder may have released while the judge ran.
      const holderRow = await this.liveLeaseForClone(tx, clone.id, targetBranch, now2);
      const queued = await this.queuedForClone(tx, clone.id, targetBranch, now2, updateRequestId);
      const holderWorktree = holderRow
        ? ((this.rows(tx, 'gitWorktrees')?.filter(row => row.id === holderRow.worktreeId) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, holderRow.worktreeId)).limit(1))).find(
            (row) => row.id === holderRow.worktreeId,
          ) ?? null
        : null;
      const holderPaths = holderRow
        ? [...readPaths(holderRow.changedPaths), ...readPaths(holderWorktree?.declaredPaths)]
        : [];
      const holderOverlap = overlappingPaths(changedPaths, holderPaths);
      // Live peers' git_join declarations are reported, not arbitrated (see
      // resolveVerdict). Before this, a peer without the lease never counted and
      // the reason claimed "no declared paths overlap" over its declarations.
      const peerOverlap = peerDeclarationOverlap(
        changedPaths,
        await this.livePeerDeclarations(tx, clone.id, [worktree.id, holderRow?.worktreeId ?? null], targetBranch, now2),
      );
      const overlap = [...new Set([...holderOverlap, ...peerOverlap.flatMap((peer) => peer.paths)])].sort();

      const resolved = resolveVerdict({
        holderPresent: Boolean(holderRow),
        overlap: holderOverlap,
        peerOverlap,
        judged,
        judgeConsulted: Boolean(decision.brief),
      });

      const id = updateRequestId ?? randomUUID();
      const leaseExpiresAt =
        resolved.verdict === 'allow' ? isoOffsetSeconds(LEASE_TTL_SECONDS, new Date(now2)) : null;
      const row = {
        id,
        cloneId: clone.id,
        worktreeId: worktree.id,
        clientRequestId,
        targetBranch,
        baseSha,
        headSha,
        changedPaths: changedPaths.length > 0 ? changedPaths : null,
        verdict: resolved.verdict,
        decidedBy: resolved.decidedBy,
        reason: resolved.reason,
        overlap: overlap.length > 0 ? overlap : null,
        holderWorktreeId: holderRow?.worktreeId ?? null,
        model: resolved.decidedBy === 'llm' ? model : null,
        leaseExpiresAt,
        // On a re-decide this is only used for the response; the UPDATE below
        // deliberately does not write it, so "waiting since" stays the first ask.
        requestedAt: existing?.requestedAt ?? now2,
        decidedAt: now2,
        renewedAt: updateRequestId === null ? null : now2,
        completedAt: resolved.verdict === 'deny' ? now2 : null,
        createdAt: existing?.createdAt ?? now2,
        updatedAt: now2,
      };
      if (updateRequestId !== null) {
        // Re-decide in place. `requestedAt` is deliberately preserved: it is when
        // the caller first asked, which is what queue order and "how long has
        // this been waiting" both depend on.
        await this.updateRows(tx, 'gitMergeRequests', [updateRequestId], {
            verdict: resolved.verdict,
            decidedBy: resolved.decidedBy,
            reason: resolved.reason,
            overlap: overlap.length > 0 ? overlap : null,
            holderWorktreeId: holderRow?.worktreeId ?? null,
            model: resolved.decidedBy === 'llm' ? model : null,
            leaseExpiresAt,
            decidedAt: now2,
            renewedAt: now2,
            completedAt: resolved.verdict === 'deny' ? now2 : null,
            updatedAt: now2,
          });
        await this.updateRows(tx, 'gitWorktrees', [worktree.id], { heartbeatAt: now2, updatedAt: now2 });
        this.publish(tx, 'merge_request', clone.id);
        if (existing?.verdict !== resolved.verdict || existing?.holderWorktreeId !== (holderRow?.worktreeId ?? null) || JSON.stringify(readPaths(existing?.overlap)) !== JSON.stringify(overlap)) await this.notify(tx, { kind: 'merge_decision_changed', clone, worktree, targetBranch, requestId: id, audience: 'branch', ownerWorktrees: holderWorktree ? [holderWorktree] : [], detail: { verdict: resolved.verdict, peer_overlap: peerOverlap } });
        return this.requestWire(row as unknown as GitMergeRequest, {
          replayed: false,
          holder: holderWorktree,
          queueDepth: queued.length,
          peerOverlap,
        }, tx);
      }
      try {
        await this.insertRow(tx, 'gitMergeRequests', row);
      } catch {
        // Lost the idempotency race with a concurrent retry: return theirs.
        const winner = (
          await tx
            .select()
            .from(gitMergeRequests)
            .where(
              and(
                eq(gitMergeRequests.worktreeId, worktree.id),
                eq(gitMergeRequests.clientRequestId, clientRequestId),
              ),
            )
            .limit(1)
        ).find((r) => r.worktreeId === worktree.id && r.clientRequestId === clientRequestId);
        if (winner) return this.requestWire(winner, { replayed: true }, tx);
        throw new ConflictError('Merge request could not be recorded', 'git_director_conflict');
      }

      await this.updateRows(tx, 'gitWorktrees', [worktree.id], { targetBranch, heartbeatAt: now2, updatedAt: now2 });
      this.publish(tx, 'merge_request', clone.id);
      const overlapIds = peerOverlap.map(peer => peer.worktree_id);
      const overlappingPeers = overlapIds.length ? this.rows(tx, 'gitWorktrees')?.filter(row => overlapIds.includes(row.id)) ?? await tx.select().from(gitWorktrees).where(inArray(gitWorktrees.id, overlapIds)) : [];
      await this.notify(tx, { kind: 'merge_requested', clone, worktree, targetBranch, requestId: id, audience: 'owners', ownerWorktrees: [...(holderWorktree ? [holderWorktree] : []), ...overlappingPeers], detail: { verdict: resolved.verdict, peer_overlap: peerOverlap } });

      return this.requestWire(row as unknown as GitMergeRequest, {
        replayed: false,
        holder: holderWorktree,
        queueDepth: queued.length,
        peerOverlap,
      }, tx);
    });
  }

  /**
   * Re-decide a `wait`, or renew a live lease.
   *
   * Promotion remains poll-driven. State-change notices ask eligible live
   * waiters to recheck; they never grant or renew a lease. Expiry remains
   * sweep-on-read, so callers retain polling even when messaging is enabled.
   */
  async mergeStatus(args: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const requestId = requiredString(args, 'request_id', 36);
    const now = this.now();

    if (this.snapshot()) {
      await this.sweepForRead(now);
      const request=await this.requireRequest(this.deps.db,requestId,host);
      if(request.verdict!=='wait'||request.completedAt)return this.requestWire(request,{renewed:false});
      const inputs=this.waitInputs(request);
      if(this.evaluatedWaits.get(request.id)===inputs)return this.requestWire(request,{renewed:false});
      const worktree=this.snapshot()!.table('gitWorktrees').get(request.worktreeId);
      if(!worktree||!this.registrationProof(worktree))return this.requestWire(request,{renewed:false});
      const result=await this.decideAndRecord({host,now,worktreePath:worktree.worktreePath,targetBranch:request.targetBranch,clientRequestId:request.clientRequestId,baseSha:request.baseSha,headSha:request.headSha,changedPaths:readPaths(request.changedPaths),updateRequestId:request.id});
      this.evaluatedWaits.set(request.id,this.waitInputs(request));return result;
    }

    const current = await this.transaction(async (tx) => {
      await lockClaimGate(tx);
      const polling = await this.requireRequest(tx, requestId, host);
      if (!polling.completedAt && (polling.verdict === 'allow' || polling.verdict === 'wait')) {
        // A status poll proves this holder is still working, just as git_list
        // with a worktree path does. Refresh before sweeping the fallback TTL;
        // never revive a released/replaced registration or an expired lease.
        await tx
          .update(gitWorktrees)
          .set({
            heartbeatAt: now,
            expiresAt: isoOffsetSeconds(REGISTRATION_TTL_SECONDS, new Date(now)),
            updatedAt: now,
          })
          .where(and(
            eq(gitWorktrees.id, polling.worktreeId),
            eq(gitWorktrees.hostId, host.id),
            eq(gitWorktrees.status, 'active'),
          ));
      }
      await this.sweepExpired(tx, now);
      const request = await this.requireRequest(tx, requestId, host);
      if (request.verdict === 'allow' && !request.completedAt) {
        const [wt] = (this.rows(tx, 'gitWorktrees')?.filter(row => row.id === request.worktreeId) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, request.worktreeId)));
        const [clone] = (this.rows(tx, 'gitClones')?.filter(row => row.id === request.cloneId) ?? await tx.select().from(gitClones).where(eq(gitClones.id, request.cloneId)));
        if (wt && clone) await guardGitMutation(tx, clone, wt, request.targetBranch, readPaths(request.changedPaths));
        const leaseExpiresAt = isoOffsetSeconds(LEASE_TTL_SECONDS, new Date(now));
        await this.updateRows(tx, 'gitMergeRequests', [request.id], { leaseExpiresAt, renewedAt: now, updatedAt: now });
        return { ...request, leaseExpiresAt, renewedAt: now, renewed: true };
      }
      return { ...request, renewed: false };
    });

    if (current.verdict !== 'wait') {
      return this.requestWire(current as GitMergeRequest, { renewed: current.renewed });
    }

    // A waiting request re-runs the full decision against current state, and
    // writes the answer back onto the SAME row. Polling must not mint rows: the
    // caller's `request_id` would change underneath them, and each poll would
    // count as another queued contender — inflating the queue the arbiter is
    // shown the longer somebody waits.
    const worktree = (
      await this.deps.db.select().from(gitWorktrees).where(eq(gitWorktrees.id, current.worktreeId)).limit(1)
    ).find((row) => row.id === current.worktreeId);
    if (!worktree) throw new NotFoundError('Worktree is no longer registered', 'git_director_worktree_not_found');

    return await this.decideAndRecord({
      host,
      now,
      worktreePath: worktree.worktreePath,
      targetBranch: current.targetBranch,
      clientRequestId: current.clientRequestId,
      baseSha: current.baseSha,
      headSha: current.headSha,
      changedPaths: readPaths(current.changedPaths),
      updateRequestId: current.id,
    });
  }

  /** Release a lease, a queued request, or the registration itself. */
  async release(args: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const now = this.now();
    const requestId = optionalString(args, 'request_id', 36);
    const worktreePath = optionalString(args, 'worktree_path');
    const deregister = args.deregister === true;
    const correctionReason = optionalString(args, 'correction_reason', 1000);
    const correctionId = optionalString(args, 'correction_id', 36);
    if ((correctionReason || correctionId) && (!correctionReason || !correctionId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(correctionId))) throw new ValidationError('An outcome correction requires correction_reason and a UUID correction_id');
    const outcome = optionalString(args, 'outcome', 32) ?? 'unknown';
    const targetHeadSha = optionalString(args, 'target_head_sha', 64);
    if (!['merged', 'aborted', 'unknown'].includes(outcome)) throw new ValidationError('outcome must be merged, aborted or unknown');
    if (args.outcome !== undefined && (!requestId || !worktreePath)) throw new ValidationError('request_id and worktree_path are required for a reported outcome');
    if (outcome === 'merged' && !targetHeadSha) throw new ValidationError('target_head_sha is required for a reported merge');
    if (outcome === 'merged' && !/^[a-f0-9]{40,64}$/.test(targetHeadSha!)) throw new ValidationError('target_head_sha must be a full 40-64 lowercase hex commit SHA; use git rev-parse HEAD');
    if (!requestId && !worktreePath) {
      throw new ValidationError('request_id or worktree_path is required', { param: 'request_id' });
    }

    return await this.transaction(async (tx) => {
      await lockClaimGate(tx);
      await this.sweepExpired(tx, now);
      let released = 0;
      let cloneId: string | null = null;
      const releasedRequests: GitMergeRequest[] = [];
      let reported: GitMergeRequest | null = null;

      if (requestId) {
        const request = await this.requireRequest(tx, requestId, host);
        if (this.snapshot(tx)) { const registration=this.snapshot(tx)!.table('gitWorktrees').get(request.worktreeId); if(!registration) throw new ConflictError('Registration missing','git_director_owner_uncertain'); this.requireRegistrationProof(registration, true); }
        cloneId = request.cloneId;
        if (args.outcome !== undefined) {
          const [owner] = (this.rows(tx, 'gitWorktrees')?.filter(row => row.id === request.worktreeId) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, request.worktreeId)));
          if (!owner || owner.worktreePath !== normalizePath(worktreePath!)) throw new ValidationError('worktree_path does not match the reported request');
          if (outcome === 'merged' && !request.leaseExpiresAt) throw new ValidationError('A merged report requires a request that held a lease');
          if (correctionReason) {
            if (deregister || outcome !== 'merged' || request.reportedOutcome !== 'merged' || !request.completedAt)
              throw new ValidationError('Corrections require an already completed merged report and cannot release or deregister anything');
            const [existing] = await tx.select().from(adminEvents).where(and(
              eq(adminEvents.type, 'git_director.outcome_correction'), eq(adminEvents.hostId, host.id),
              sql`JSON_UNQUOTE(JSON_EXTRACT(${adminEvents.payload}, '$.correction_id')) = ${correctionId}`,
            )).limit(1);
            const correction = { correction_id: correctionId, request_id: request.id, original_target_head_sha: request.reportedTargetHeadSha,
              corrected_target_head_sha: targetHeadSha, reason: correctionReason, evidence: 'agent_reported', verified: false };
            if (existing && Object.entries(correction).some(([key, value]) => (existing.payload as Record<string, unknown>)?.[key] !== value))
              throw new ConflictError('Correction ID reused with different evidence', 'git_director_outcome_conflict');
            if (!existing) { const context=this.ownedContext.getStore()?.ctx; if(context) adminAudit(context,'git_director.outcome_correction',correction,now,host.id); else await tx.insert(adminEvents).values({ type: 'git_director.outcome_correction', hostId: host.id, payload: correction, createdAt: now }); }
            return { released: 0, deregistered: false, corrected: true, replayed: Boolean(existing), correction };
          }
          const refinement = request.reportedOutcome === 'unknown' && outcome !== 'unknown';
          if (!refinement && request.reportedOutcome != null && (request.reportedOutcome !== outcome || request.reportedTargetHeadSha !== targetHeadSha)) {
            throw new ConflictError('A different outcome was already reported for this request', 'git_director_outcome_conflict');
          }
          if (request.reportedOutcome == null || refinement) {
            await this.updateRows(tx, 'gitMergeRequests', [request.id], { reportedOutcome: outcome, reportedTargetHeadSha: targetHeadSha, outcomeReportedAt: now, updatedAt: now });
            reported = request;
          }
        }
        if (!request.completedAt) {
          await this.updateRows(tx, 'gitMergeRequests', [request.id], { verdict: 'withdrawn', reason: 'Withdrawn by git_release or superseding registration; merge outcome is unknown.', completedAt: now, updatedAt: now });
          released += 1;
          releasedRequests.push(request);
        }
      }

      if (worktreePath) {
        const worktree = await this.worktreeForPath(tx, host, normalizePath(worktreePath));
        const clone = await this.cloneForWorktree(tx, host, normalizePath(worktreePath));
        if (!worktree || !clone) throw new NotFoundError('Worktree not registered', 'git_director_worktree_not_found');
        if (this.snapshot(tx)) this.requireRegistrationProof(worktree, true);
        cloneId = clone.id;
        const live = args.outcome !== undefined && requestId && !deregister ? [] : await this.liveRequestsForWorktree(tx, worktree.id, now);
        if (live.length > 0) {
          await this.updateRows(tx, 'gitMergeRequests', live.map((row) => row.id), { verdict: 'withdrawn', reason: 'Withdrawn by git_release or superseding registration; merge outcome is unknown.', completedAt: now, updatedAt: now });
          released += live.length;
          releasedRequests.push(...live);
        }
        if (deregister) {
          await this.updateRows(tx, 'gitWorktrees', [worktree.id], { status: 'released', releasedAt: now, updatedAt: now });
        }
      }

      for (const request of releasedRequests) {
        const [clone] = (this.rows(tx, 'gitClones')?.filter(row => row.id === request.cloneId) ?? await tx.select().from(gitClones).where(eq(gitClones.id, request.cloneId)));
        const [worktree] = (this.rows(tx, 'gitWorktrees')?.filter(row => row.id === request.worktreeId) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, request.worktreeId)));
        if (reported?.id !== request.id) await this.notify(tx, { kind: 'merge_released', clone, worktree, targetBranch: request.targetBranch, requestId: request.id, audience: 'branch', detail: { recheck_required: true, merge_outcome: 'unknown' } });
      }
      if (reported) {
        const [clone] = (this.rows(tx, 'gitClones')?.filter(row => row.id === reported.cloneId) ?? await tx.select().from(gitClones).where(eq(gitClones.id, reported.cloneId)));
        const [worktree] = (this.rows(tx, 'gitWorktrees')?.filter(row => row.id === reported.worktreeId) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, reported.worktreeId)));
        await this.notify(tx, { kind: 'merge_reported', clone, worktree, targetBranch: reported.targetBranch, requestId: reported.id, audience: outcome === 'merged' ? 'repository' : 'branch', detail: { recheck_required: true, merge_outcome: outcome, target_head_sha: targetHeadSha, evidence: 'agent_reported', verified: false } });
      }
      if (cloneId) this.publish(tx, 'release', cloneId);
      return { released, deregistered: deregister, reported: Boolean(reported), evidence: reported ? 'agent_reported' : null };
    });
  }

  // ── admin surface ─────────────────────────────────────────────────────────

  /**
   * The console's registry listing: every live clone with its worktrees, open
   * leases, retired registrations and recent decisions.
   *
   * Four set-based reads however many clones there are. This used to run four
   * queries per clone in sequence, and a fleet that has registered several
   * hundred clones (most of them dormant) spent seconds on round trips before
   * the page could show anything.
   */
  async adminClones(): Promise<Array<Record<string, unknown>>> {
    const db = this.deps.db;
    const now = this.now();
    await this.sweepForRead(now);
    const snapshot = this.snapshot(db);
    if (snapshot) {
      const clones = snapshot.table('gitClones').all().filter(row => !row.archivedAt).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt));
      return Promise.all(clones.map(async clone => ({...this.cloneWire(clone,null), fqdn:snapshot.hosts.get(clone.hostId)?.fqdn??null, worktrees:await this.worktreeWire(db,clone.id,now), leases:await this.leaseWire(db,clone.id,now), stale:await this.staleWire(db,clone.id,now), recent:await this.recentWire(db,clone.id)})));
    }
    const clones = await db.select().from(gitClones).where(isNull(gitClones.archivedAt));
    if (clones.length === 0) return [];
    clones.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));

    const [hostRows, worktrees, openRequests, recentIds] = await Promise.all([
      db.select({ id: hosts.id, fqdn: hosts.fqdn }).from(hosts),
      // Released registrations are the bulk of the table and are never listed.
      db.select().from(gitWorktrees).where(inArray(gitWorktrees.status, ['active', 'expired', 'abandoned', 'superseded'])),
      db.select().from(gitMergeRequests).where(and(inArray(gitMergeRequests.verdict, ['allow', 'wait']), isNull(gitMergeRequests.completedAt))),
      // The newest 25 decisions per clone, picked in one pass.
      db.execute(sql`SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY clone_id ORDER BY requested_at DESC) AS rn FROM git_merge_requests
      ) ranked WHERE rn <= 25`),
    ]);
    const ids = ((Array.isArray(recentIds) ? recentIds[0] : recentIds) as unknown as Array<{ id: string }>).map((row) => row.id);
    const recentRows = ids.length ? await db.select().from(gitMergeRequests).where(inArray(gitMergeRequests.id, ids)) : [];

    const byClone = <T extends { cloneId: string }>(rows: T[]) => {
      const out = new Map<string, T[]>();
      for (const row of rows) (out.get(row.cloneId) ?? out.set(row.cloneId, []).get(row.cloneId)!).push(row);
      return out;
    };
    const worktreesBy = byClone(worktrees);
    const leasesBy = byClone(openRequests);
    const recentBy = byClone(recentRows);
    const fqdnById = new Map(hostRows.map((row) => [row.id, row.fqdn]));

    return clones.map((clone) => ({
      ...this.cloneWire(clone, null),
      fqdn: fqdnById.get(clone.hostId) ?? null,
      worktrees: this.worktreeWireRows(worktreesBy.get(clone.id) ?? [], now),
      leases: this.leaseWireRows(leasesBy.get(clone.id) ?? [], now),
      stale: this.staleWireRows(worktreesBy.get(clone.id) ?? []),
      recent: this.recentWireRows(recentBy.get(clone.id) ?? []),
    }));
  }

  /**
   * Operator force-allow / force-deny from the console. Writes
   * `decided_by: 'operator'` so the audit trail never attributes a human's call
   * to the model.
   */
  async adminDecide(requestId: string, verdict: 'allow' | 'deny', reason: string | null): Promise<Record<string, unknown>> {
    if (verdict !== 'allow' && verdict !== 'deny') {
      throw new ValidationError('verdict must be "allow" or "deny"', { param: 'verdict' });
    }
    return await this.transaction(async (tx) => {
      await lockClaimGate(tx);
      const now = this.now();
      await this.sweepExpired(tx, now);
      const rows = this.rows(tx, 'gitMergeRequests') ?? (this.rows(tx, 'gitMergeRequests')?.filter(row => row.id === requestId) ?? await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.id, requestId)).limit(1).for('update'));
      const request = rows.find((row) => row.id === requestId);
      if (!request) throw new NotFoundError('Merge request not found', 'git_director_request_not_found');
      if (request.completedAt || !['allow', 'wait'].includes(request.verdict))
        throw new ConflictError('Completed merge requests cannot be overridden', 'git_director_request_completed');
      const [clone] = (this.rows(tx, 'gitClones')?.filter(row => row.id === request.cloneId) ?? await tx.select().from(gitClones).where(eq(gitClones.id, request.cloneId)).limit(1).for('update'));
      const [worktree] = (this.rows(tx, 'gitWorktrees')?.filter(row => row.id === request.worktreeId) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, request.worktreeId)));
      if (verdict === 'allow') {
        if (!clone || clone.archivedAt || !worktree || worktree.status !== 'active' || worktree.cloneId !== clone.id)
          throw new ConflictError('An active worktree is required for a merge lease', 'git_director_worktree_inactive');
        await guardGitMutation(tx, clone, worktree, request.targetBranch, readPaths(request.changedPaths), this.snapshot(tx));
        if(this.snapshot(tx))this.requireRegistrationProof(worktree);
        if (await this.liveLeaseForClone(tx, clone.id, request.targetBranch, now, request.id))
          throw new ConflictError('Another request holds the lease on this branch', 'git_director_lease_held');
      }
      const leaseExpiresAt = verdict === 'allow'
        ? request.verdict === 'allow' ? request.leaseExpiresAt : isoOffsetSeconds(LEASE_TTL_SECONDS, new Date(now))
        : null;
      await this.updateRows(tx, 'gitMergeRequests', [requestId], {
          verdict,
          decidedBy: 'operator',
          reason: reason?.trim() || `Forced ${verdict} by an operator from the console.`,
          leaseExpiresAt,
          decidedAt: now,
          completedAt: verdict === 'deny' ? now : null,
          updatedAt: now,
        });
      this.publish(tx, 'decision', request.cloneId);
      if (request.verdict !== verdict || request.decidedBy !== 'operator' || request.reason !== (reason?.trim() || `Forced ${verdict} by an operator from the console.`)) {
        const grants = (this.rows(tx, 'gitMergeRequests')?.filter(row => row.cloneId === request.cloneId) ?? await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.cloneId, request.cloneId)));
        const holderIds = grants.filter(r => r.verdict === 'allow' && !r.completedAt && r.targetBranch === request.targetBranch && !isExpired(r.leaseExpiresAt, now)).map(r => r.worktreeId);
        const holders = holderIds.length ? this.rows(tx, 'gitWorktrees')?.filter(row => holderIds.includes(row.id)) ?? await tx.select().from(gitWorktrees).where(inArray(gitWorktrees.id, holderIds)) : [];
        await this.notify(tx, { kind: 'operator_decision', clone, worktree, targetBranch: request.targetBranch, requestId, audience: 'branch', includeActor: true, ownerWorktrees: holders, detail: { verdict, recheck_required: true, other_leases_revoked: false } });
      }
      const updated = ((this.rows(tx, 'gitMergeRequests')?.filter(row => row.id === requestId) ?? await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.id, requestId)).limit(1))).find(
        (row) => row.id === requestId,
      );
      return this.requestWire(updated ?? request, {}, tx);
    });
  }

  /**
   * Operator eviction of a forgotten registration.
   *
   * The automatic paths cover an agent whose session the fleet can see died, and
   * one that went quiet past its TTL. Neither covers the case a human is
   * actually looking at: a registration that is technically alive — a wrapper
   * still attached, the TTL still running — belonging to something nobody
   * believes is still working. Waiting out a TTL you can see is the wrong answer
   * when you already know, so the console gets a direct release.
   *
   * Drops the registration and withdraws everything it had outstanding, so a
   * branch it was sitting on frees immediately rather than on the lease TTL.
   */
  async adminEvictWorktree(worktreeId: string): Promise<Record<string, unknown>> {
    const now = this.now();
    return await this.transaction(async (tx) => {
      await lockClaimGate(tx);
      const rows = (this.rows(tx, 'gitWorktrees')?.filter(row => row.id === worktreeId) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, worktreeId)).limit(1).for('update'));
      const worktree = rows.find((row) => row.id === worktreeId);
      if (!worktree) throw new NotFoundError('Worktree not found', 'git_director_worktree_not_found');

      const live = await this.liveRequestsForWorktree(tx, worktree.id, now);
      if (live.length > 0) {
        await this.updateRows(tx, 'gitMergeRequests', live.map((row) => row.id), {
            verdict: 'withdrawn',
            completedAt: now,
            reason: 'Withdrawn: an operator evicted the holding registration from the console.',
            updatedAt: now,
          });
      }
      await this.updateRows(tx, 'gitWorktrees', [worktree.id], { status: 'released', releasedAt: now, updatedAt: now });
      this.publish(tx, 'evict', worktree.cloneId);
      if (['active','uncertain'].includes(worktree.status) || live.length) {
        const [clone] = (this.rows(tx, 'gitClones')?.filter(row => row.id === worktree.cloneId) ?? await tx.select().from(gitClones).where(eq(gitClones.id, worktree.cloneId)));
        await this.notify(tx, { kind: 'operator_eviction', clone, worktree, audience: 'branch', includeActor: true, detail: { recheck_required: true, withdrawn_requests: live.map(r => r.id) } });
      }
      return { evicted: true, worktree_id: worktree.id, released: live.length };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async upsertCloneLocked(
    tx: GitDirectorDb,
    input: {
      host: Host;
      cloneKey: string;
      cloneDir: string;
      repoRoot: string;
      remoteUrl: string | null;
      remoteKey: string | null;
      now: string;
    },
  ): Promise<GitClone> {
    const rows = this.rows(tx, 'gitClones') ?? await tx
      .select()
      .from(gitClones)
      .where(and(eq(gitClones.hostId, input.host.id), eq(gitClones.cloneKey, input.cloneKey)))
      .limit(1)
      .for('update');
    const existing = rows.find(
      (row) => row.hostId === input.host.id && row.cloneKey === input.cloneKey,
    );
    if (existing) {
      await this.updateRows(tx, 'gitClones', [existing.id], {
          repoRoot: input.repoRoot,
          remoteUrl: input.remoteUrl ?? existing.remoteUrl,
          remoteKey: input.remoteKey ?? existing.remoteKey,
          lastSeenAt: input.now,
          archivedAt: null,
          updatedAt: input.now,
        });
      return {
        ...existing,
        repoRoot: input.repoRoot,
        remoteUrl: input.remoteUrl ?? existing.remoteUrl,
        remoteKey: input.remoteKey ?? existing.remoteKey,
        lastSeenAt: input.now,
        archivedAt: null,
      };
    }
    const clone: GitClone = {
      id: randomUUID(),
      hostId: input.host.id,
      cloneKey: input.cloneKey,
      cloneDir: input.cloneDir,
      repoRoot: input.repoRoot,
      remoteUrl: input.remoteUrl,
      remoteKey: input.remoteKey,
      defaultBranch: null,
      firstSeenAt: input.now,
      lastSeenAt: input.now,
      archivedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    await this.insertRow(tx, 'gitClones', clone);
    this.publish(tx, 'clone', clone.id);
    return clone;
  }

  /**
   * Enrichment only. When Agent Messaging is on, an address already exists for
   * (host, engine, user, cwd) and carries liveness we would otherwise have to
   * invent. When it is off there is no row and everything still works.
   */
  private async resolveAddress(
    tx: GitDirectorDb,
    host: Host,
    username: string | null,
    engine: string | null,
    worktreePath: string,
    now: string,
  ): Promise<{ id: string; username: string; sessionId: string; generation: number } | null> {
    if (!engine) return null;
    const cwdHash = sha256(worktreePath);
    const snapshot = this.snapshot(tx), owner = ownerRuntimeFor(tx);
    if(snapshot&&owner){
      const principal=currentNativePrincipal();if(!principal)throw nativeRegistrationRequired('Authenticated native session required for registration');
      const {session}=ownedBridge(snapshot,principal.sessionId,principal.bridgeToken),workspace=readWorkspace(session.workspace);
      if(session.hostId!==host.id||session.engine!==engine||username&&session.username!==username||(workspace?.git_root??workspace?.cwd??session.cwd)!==worktreePath)throw nativeRegistrationRequired('Registration differs from authenticated native session', true);
      const attachment=nativeClaimAttachment(owner,session),address=session.agentBusAddressId?snapshot.addresses.get(session.agentBusAddressId):undefined;
      if((!attachment&&!legacyDrainFor(owner)?.session(session.id,session.bindingGeneration))||address?.currentSessionId!==session.id||address.bindingGeneration!==session.bindingGeneration)return null;
      this.ownedContext.getStore()?.checks.push(current=>{const checked=ownedBridge(current,principal.sessionId,principal.bridgeToken).session;if(checked.bindingGeneration!==session.bindingGeneration)throw new ConflictError('Native binding changed','git_director_owner_uncertain');});
      return {id:address.id,username:session.username,sessionId:session.id,generation:session.bindingGeneration};
    }

    try {
      const rows = await tx
        .select({
          id: agentBusAddresses.id,
          hostId: agentBusAddresses.hostId,
          engine: agentBusAddresses.engine,
          username: agentBusAddresses.username,
          cwdHash: agentBusAddresses.cwdHash,
          archivedAt: agentBusAddresses.archivedAt,
          currentSessionId: agentBusAddresses.currentSessionId,
          bindingGeneration: agentBusAddresses.bindingGeneration,
          lastUpstreamSessionId: agentBusAddresses.lastUpstreamSessionId,
          receiveHeartbeatAt: agentBusAddresses.receiveHeartbeatAt,
          enabled: agentBusAddresses.enabled,
          readiness: agentBusAddresses.readiness,
          session: { heartbeatAt: agentSessions.heartbeatAt, endedAt: agentSessions.endedAt, workspace: agentSessions.workspace },
        })
        .from(agentBusAddresses)
        .leftJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
        .where(and(
          eq(agentBusAddresses.hostId, host.id),
          eq(agentBusAddresses.engine, engine),
          username === null ? undefined : eq(agentBusAddresses.username, username),
          isNull(agentBusAddresses.archivedAt),
        ));
      const freshAfter = isoOffsetSeconds(
        -(this.deps.freshSeconds ?? AGENT_PRESENCE_FRESH_SECONDS),
        parseIso(now) ?? new Date(),
      );
      const live = rows.filter(
        (row) =>
          row.hostId === host.id &&
          (readWorkspace(row.session?.workspace)?.git_root ?? readWorkspace(row.session?.workspace)?.cwd ?? (row.cwdHash === cwdHash ? worktreePath : null)) === worktreePath &&
          row.engine === engine &&
          (username === null || row.username === username) &&
          isPresent(deriveAddressPresence(row, row.session, freshAfter)),
      );
      // Host MCP has no session-bound username. Infer it only when this engine
      // and directory identify exactly one live address; an arbitrary match
      // could make another agent's exit reclaim this registration.
      const match = live.length === 1 ? live[0] : undefined;
      return match?.currentSessionId ? { id: match.id, username: match.username, sessionId: match.currentSessionId, generation: match.bindingGeneration } : null;
    } catch {
      // Agent Messaging tables may not exist on a box mid-deploy. Enrichment is
      // optional by construction, so a miss must never fail a registration.
      return null;
    }
  }

  private async worktreeForPath(
    tx: GitDirectorDb,
    host: Host,
    worktreePath: string,
  ): Promise<GitWorktree | null> {
    const worktreeHash = sha256(worktreePath);
    const rows = (
      this.rows(tx, 'gitWorktrees') ?? await tx
        .select()
        .from(gitWorktrees)
        .where(and(eq(gitWorktrees.hostId, host.id), eq(gitWorktrees.worktreeHash, worktreeHash)))
    ).filter(
      (row) => row.hostId === host.id && row.worktreeHash === worktreeHash && row.status !== 'superseded',
    );
    if (rows.length > 1)
      throw new ConflictError(
        'Multiple clones are registered for this host/path. Call git_register with the correct absolute git-common-dir first.',
        'git_director_worktree_ambiguous',
      );
    return rows[0] ?? null;
  }

  private async cloneForWorktree(
    tx: GitDirectorDb,
    host: Host,
    worktreePath: string,
  ): Promise<GitClone | null> {
    const worktree = await this.worktreeForPath(tx, host, worktreePath);
    if (!worktree) return null;
    const clones = this.rows(tx, 'gitClones') ?? (this.rows(tx, 'gitClones')?.filter(row => row.id === worktree.cloneId) ?? await tx.select().from(gitClones).where(eq(gitClones.id, worktree.cloneId)).limit(1));
    return clones.find((row) => row.id === worktree.cloneId) ?? null;
  }

  /**
   * Resolve a worktree AND treat the call as proof of life.
   *
   * Every Director tool that names a worktree refreshes it here, which is the
   * other half of handling forgotten clients: an agent that is still working
   * keeps its own registration alive simply by using the tools, so the TTL only
   * ever reaps something that genuinely stopped talking. Without this, a busy
   * agent that went an hour between merges would be swept as abandoned while
   * still holding the directory.
   *
   * A row the sweep already retired is revived rather than refused. Reaching
   * this line is itself evidence the agent is back — a restarted session, or one
   * whose bound address died and was rebuilt — and making it re-run
   * `git_register` before it may ask about its own worktree would be friction
   * that buys nothing.
   */
  private async requireWorktree(
    tx: GitDirectorDb,
    host: Host,
    worktreePath: string,
    now: string,
  ): Promise<{ clone: GitClone; worktree: GitWorktree }> {
    if (!this.snapshot(tx)) await tx.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, host.id)).for('update');
    const worktree = await this.worktreeForPath(tx, host, worktreePath);
    if (!worktree) {
      throw new NotFoundError(
        `No registration for ${worktreePath}. Call git_register for this worktree first.`,
        'git_director_worktree_not_found',
      );
    }
    const clones = this.rows(tx, 'gitClones') ?? (this.rows(tx, 'gitClones')?.filter(row => row.id === worktree.cloneId) ?? await tx.select().from(gitClones).where(eq(gitClones.id, worktree.cloneId)).limit(1));
    const clone = clones.find((row) => row.id === worktree.cloneId);
    if (!clone) throw new NotFoundError('Clone not found', 'git_director_clone_not_found');

    if (this.snapshot(tx)) { this.requireRegistrationProof(worktree, true); return { clone, worktree }; }
    const expiresAt = isoOffsetSeconds(REGISTRATION_TTL_SECONDS, new Date(now));
    await this.updateRows(tx, 'gitWorktrees', [worktree.id], { status: 'active', heartbeatAt: now, expiresAt, releasedAt: null, updatedAt: now });
    return {
      clone,
      worktree: { ...worktree, status: 'active', heartbeatAt: now, expiresAt, releasedAt: null },
    };
  }

  private async requireRequest(tx: GitDirectorDb, requestId: string, host: Host): Promise<GitMergeRequest> {
    const rows = this.rows(tx, 'gitMergeRequests') ?? (this.rows(tx, 'gitMergeRequests')?.filter(row => row.id === requestId) ?? await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.id, requestId)).limit(1));
    let request = rows.find((row) => row.id === requestId);
    if (!request && this.snapshot(tx)) {
      request=(await this.deps.db.select().from(gitMergeRequests).where(eq(gitMergeRequests.id,requestId)).limit(1))[0];
      if (request && !request.completedAt) throw new Error('Unresolved Git request missing from authoritative working set');
      if(request)this.ownedContext.getStore()?.ctx.draft.upsert('gitMergeRequests',request);
    }
    if (!request) throw new NotFoundError('Merge request not found', 'git_director_request_not_found');
    const clones = this.rows(tx, 'gitClones') ?? (this.rows(tx, 'gitClones')?.filter(row => row.id === request.cloneId) ?? await tx.select().from(gitClones).where(eq(gitClones.id, request.cloneId)).limit(1));
    const clone = clones.find((row) => row.id === request.cloneId);
    if (!clone || clone.hostId !== host.id) {
      throw new NotFoundError('Merge request not found', 'git_director_request_not_found');
    }
    return request;
  }

  private async liveLeaseForClone(
    tx: GitDirectorDb,
    cloneId: string,
    targetBranch: string,
    now: string,
    excludeRequestId?: string,
  ): Promise<GitMergeRequest | null> {
    const rows = this.rows(tx, 'gitMergeRequests') ?? await tx
      .select()
      .from(gitMergeRequests)
      .where(and(
        eq(gitMergeRequests.cloneId, cloneId),
        eq(gitMergeRequests.targetBranch, targetBranch),
        eq(gitMergeRequests.verdict, 'allow'),
        isNull(gitMergeRequests.completedAt),
        excludeRequestId ? ne(gitMergeRequests.id, excludeRequestId) : undefined,
      ));
    return (
      rows.find(
        (row) =>
          row.cloneId === cloneId &&
          row.id !== excludeRequestId &&
          row.verdict === 'allow' &&
          row.targetBranch === targetBranch &&
          !row.completedAt &&
          !isExpired(row.leaseExpiresAt, now),
      ) ?? null
    );
  }

  /**
   * Live registrations in the clone whose `git_join` declarations should be
   * checked against a merge request: active, unexpired, not excluded (the
   * requester and the lease holder, whose declarations already count as holder
   * paths), with declared paths, and aimed at this target branch or at none.
   */
  private async livePeerDeclarations(
    tx: GitDirectorDb,
    cloneId: string,
    excludeWorktreeIds: ReadonlyArray<string | null>,
    targetBranch: string,
    now: string,
  ): Promise<
    Array<{ worktree_id: string; worktree_path: string; username: string; branch: string | null; declared_paths: string[] }>
  > {
    const rows = this.rows(tx, 'gitWorktrees') ?? await tx
      .select()
      .from(gitWorktrees)
      .where(and(eq(gitWorktrees.cloneId, cloneId), eq(gitWorktrees.status, 'active')))
      .limit(200);
    return rows
      .filter(
        (row) =>
          row.cloneId === cloneId &&
          (row.status === 'active' || row.status === 'uncertain') &&
          (this.snapshot(tx) !== undefined || !isExpired(row.expiresAt, now)) &&
          !excludeWorktreeIds.includes(row.id) &&
          (row.targetBranch === null || row.targetBranch === targetBranch),
      )
      .map((row) => ({
        worktree_id: row.id,
        worktree_path: row.worktreePath,
        username: row.username,
        branch: row.branch,
        declared_paths: readPaths(row.declaredPaths),
      }))
      .filter((row) => row.declared_paths.length > 0)
      .sort((a, b) => (a.worktree_path < b.worktree_path ? -1 : 1));
  }

  private async liveLeaseForWorktree(
    tx: GitDirectorDb,
    worktreeId: string,
    now: string,
  ): Promise<GitMergeRequest | null> {
    const rows = this.rows(tx, 'gitMergeRequests') ?? await tx
      .select()
      .from(gitMergeRequests)
      .where(and(eq(gitMergeRequests.worktreeId, worktreeId), eq(gitMergeRequests.verdict, 'allow')))
      .limit(50);
    return (
      rows.find(
        (row) =>
          row.worktreeId === worktreeId &&
          row.verdict === 'allow' &&
          !row.completedAt &&
          !isExpired(row.leaseExpiresAt, now),
      ) ?? null
    );
  }

  private async liveRequestsForWorktree(
    tx: GitDirectorDb,
    worktreeId: string,
    now: string,
  ): Promise<GitMergeRequest[]> {
    void now;
    const rows = this.rows(tx, 'gitMergeRequests') ?? await tx
      .select()
      .from(gitMergeRequests)
      .where(eq(gitMergeRequests.worktreeId, worktreeId))
      .limit(200);
    return rows.filter(
      (row) =>
        row.worktreeId === worktreeId &&
        !row.completedAt &&
        (row.verdict === 'allow' || row.verdict === 'wait'),
    );
  }

  /**
   * Everyone else waiting on this branch.
   *
   * `excludeRequestId` drops the row currently being re-decided: a poller is not
   * its own rival, and counting it would report a queue one deeper than reality
   * to both the caller and the arbiter.
   */
  private async queuedForClone(
    tx: GitDirectorDb,
    cloneId: string,
    targetBranch: string,
    now: string,
    excludeRequestId: string | null = null,
  ): Promise<GitMergeRequest[]> {
    void now;
    const rows = this.rows(tx, 'gitMergeRequests') ?? await tx
      .select()
      .from(gitMergeRequests)
      .where(and(eq(gitMergeRequests.cloneId, cloneId), eq(gitMergeRequests.verdict, 'wait')))
      .limit(200);
    return rows.filter(
      (row) =>
        row.cloneId === cloneId &&
        row.verdict === 'wait' &&
        row.targetBranch === targetBranch &&
        !row.completedAt &&
        row.id !== excludeRequestId,
    );
  }

  private cloneWire(clone: GitClone, host: Host | null): Record<string, unknown> {
    return {
      clone_id: clone.id,
      host_id: clone.hostId,
      fqdn: host?.fqdn ?? null,
      repo_root: clone.repoRoot,
      remote_url: clone.remoteUrl,
      remote_key: clone.remoteKey,
      last_seen_at: clone.lastSeenAt,
    };
  }

  private async worktreeWire(tx: GitDirectorDb, cloneId: string, now: string): Promise<Array<Record<string, unknown>>> {
    return this.worktreeWireRows(this.rows(tx, 'gitWorktrees')?.filter(row => row.cloneId === cloneId) ?? (this.rows(tx, 'gitWorktrees')?.filter(row => row.cloneId === cloneId) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.cloneId, cloneId)).limit(200)), now);
  }

  private worktreeWireRows(all: GitWorktree[], now: string): Array<Record<string, unknown>> {
    const rows = all.filter((row) => this.snapshot() ? ['active','uncertain'].includes(row.status) : row.status === 'active' && !isExpired(row.expiresAt, now));
    rows.sort((a, b) => (a.worktreePath < b.worktreePath ? -1 : 1));
    return rows.map((row) => ({
      worktree_id: row.id,
      worktree_path: row.worktreePath,
      username: row.username,
      engine: row.engine,
      branch: row.branch,
      // Agent-reported at git_register or a git_list refresh, never a live read.
      head_sha: row.headSha,
      head_observed_at: row.headObservedAt ?? null,
      task: row.task,
      declared_paths: readPaths(row.declaredPaths),
      target_branch: row.targetBranch,
      agent_address_bound: Boolean(row.agentBusAddressId),
      heartbeat_at: row.heartbeatAt,
      status: row.status, ownership_mode: row.ownershipMode, uncertainty_reason: row.uncertaintyReason, presence_source: row.ownershipMode === 'connection' ? 'connection' : 'legacy_drain',
      expires_at: this.registrationExpiresAt(row),
    }));
  }

  /**
   * Registrations the sweep retired, newest first.
   *
   * Deliberately still reported. A forgotten client that simply disappeared from
   * the listing would read as "nobody was ever here", which is a worse lie than
   * a stale row — a human debugging a wedged branch needs to see that an agent
   * WAS in this worktree, when it was last seen, and whether it was reclaimed
   * because its session died or because it went quiet.
   */
  private async staleWire(tx: GitDirectorDb, cloneId: string, now: string): Promise<Array<Record<string, unknown>>> {
    void now;
    return this.staleWireRows(this.rows(tx, 'gitWorktrees')?.filter(row => row.cloneId === cloneId) ?? (this.rows(tx, 'gitWorktrees')?.filter(row => row.cloneId === cloneId) ?? await tx.select().from(gitWorktrees).where(eq(gitWorktrees.cloneId, cloneId)).limit(200)));
  }

  private staleWireRows(all: GitWorktree[]): Array<Record<string, unknown>> {
    const rows = all.filter((row) => row.status === 'expired' || row.status === 'abandoned' || row.status === 'superseded');
    rows.sort((a, b) => ((a.releasedAt ?? '') < (b.releasedAt ?? '') ? 1 : -1));
    return rows.slice(0, 25).map((row) => ({
      worktree_id: row.id,
      worktree_path: row.worktreePath,
      username: row.username,
      engine: row.engine,
      branch: row.branch,
      task: row.task,
      // 'abandoned' means the fleet knows its session ended; 'expired' only means
      // it stopped calling, which a live-but-quiet agent can also do.
      status: row.status,
      last_seen_at: row.heartbeatAt,
      released_at: row.releasedAt,
    }));
  }

  private async peerWire(
    tx: GitDirectorDb,
    cloneId: string,
    selfWorktreeId: string,
    now: string,
  ): Promise<Array<Record<string, unknown>>> {
    const all = await this.worktreeWire(tx, cloneId, now);
    return all.filter((row) => row.worktree_id !== selfWorktreeId);
  }

  private async leaseWire(tx: GitDirectorDb, cloneId: string, now: string): Promise<Array<Record<string, unknown>>> {
    return this.leaseWireRows(this.rows(tx, 'gitMergeRequests')?.filter(row => row.cloneId === cloneId) ?? (this.rows(tx, 'gitMergeRequests')?.filter(row => row.cloneId === cloneId) ?? await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.cloneId, cloneId)).limit(200)), now);
  }

  private leaseWireRows(all: GitMergeRequest[], now: string): Array<Record<string, unknown>> {
    const rows = all.filter((row) => !row.completedAt && (row.verdict === 'allow' || row.verdict === 'wait'));
    const live = rows.filter((row) => row.verdict !== 'allow' || !isExpired(row.leaseExpiresAt, now));
    live.sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1));
    return live.map((row) => ({
      request_id: row.id,
      worktree_id: row.worktreeId,
      target_branch: row.targetBranch,
      verdict: row.verdict,
      decided_by: row.decidedBy,
      reason: row.reason,
      overlap: readPaths(row.overlap),
      lease_expires_at: row.leaseExpiresAt,
      requested_at: row.requestedAt,
    }));
  }

  private async recentWire(tx: GitDirectorDb, cloneId: string): Promise<Array<Record<string, unknown>>> {
    return this.recentWireRows(
      this.rows(tx, 'gitMergeRequests')?.filter(row => row.cloneId === cloneId) ?? await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.cloneId, cloneId)).orderBy(desc(gitMergeRequests.requestedAt)).limit(25),
    );
  }

  private recentWireRows(all: GitMergeRequest[]): Array<Record<string, unknown>> {
    const rows = [...all].sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
    return rows.slice(0, 25).map((row) => ({
      request_id: row.id,
      worktree_id: row.worktreeId,
      target_branch: row.targetBranch,
      verdict: row.verdict,
      decided_by: row.decidedBy,
      reason: row.reason,
      model: row.model,
      overlap: readPaths(row.overlap),
      requested_at: row.requestedAt,
      completed_at: row.completedAt,
    }));
  }

  private async requestWire(
    request: GitMergeRequest,
    extra: {
      replayed?: boolean;
      renewed?: boolean;
      holder?: GitWorktree | null;
      queueDepth?: number;
      peerOverlap?: readonly PeerOverlap[];
    },
    revisionDb: GitDirectorDb = this.deps.db,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {
      coordination_revision: await this.notificationRevision(revisionDb),
      request_id: request.id,
      verdict: request.verdict,
      decided_by: request.decidedBy,
      reason: request.reason,
      target_branch: request.targetBranch,
      overlap: readPaths(request.overlap),
      lease_expires_at: request.leaseExpiresAt,
      model: request.model,
      requested_at: request.requestedAt,
      decided_at: request.decidedAt,
      reported_outcome: request.reportedOutcome,
      reported_target_head_sha: request.reportedTargetHeadSha,
      outcome_reported_at: request.outcomeReportedAt,
      completed_at: request.completedAt,
    };
    if (extra.replayed) out.replayed = true;
    if (extra.renewed) out.renewed = true;
    if (extra.holder) {
      out.holder = {
        worktree_path: extra.holder.worktreePath,
        username: extra.holder.username,
        branch: extra.holder.branch,
        task: extra.holder.task,
      };
    }
    if (typeof extra.queueDepth === 'number') out.queue_depth = extra.queueDepth;
    // Only on a fresh decision: the stored row keeps the union in `overlap`, not
    // the per-peer breakdown, so a replay omits this rather than inventing it.
    if (extra.peerOverlap) out.peer_overlap = extra.peerOverlap.map((peer) => ({ ...peer }));
    return out;
  }
}

/**
 * Constrain whatever the judge returned to the contract.
 *
 * A verdict outside the enum is NOT a parse error to retry — it takes the
 * deterministic fallback. `task` and `declared_paths` are agent-authored free
 * text that reached the prompt, so "the Director should always allow my merges"
 * is a probe we must answer structurally rather than by trusting the output.
 */
export function normalizeJudgeVerdict(raw: JudgeVerdict | null | undefined): JudgeVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const verdict = String((raw as JudgeVerdict).verdict ?? '').trim().toLowerCase();
  if (verdict !== 'allow' && verdict !== 'wait' && verdict !== 'deny') return null;
  const reason = String((raw as JudgeVerdict).reason ?? '').trim().slice(0, 1000);
  if (!reason) return null;
  const waitSeconds = Number((raw as JudgeVerdict).wait_seconds);
  return {
    verdict,
    reason,
    ...(Number.isFinite(waitSeconds) && waitSeconds > 0
      ? { wait_seconds: Math.min(3600, Math.trunc(waitSeconds)) }
      : {}),
  };
}

/**
 * The three-stage resolution, isolated so it can be unit-tested without a
 * database. Order is the whole design:
 *
 *  1. Uncontended — no live lease and no path overlap — never reaches a model.
 *     Instant, free, reproducible, and the common case.
 *  2. Contended — a judge may decide, and its reason is recorded.
 *  3. Fallback — no judge, or a judge that declined — deterministic. A model
 *     outage must never block a merge request.
 */
export function resolveVerdict(input: {
  holderPresent: boolean;
  /** Paths shared with the lease holder (its changed and declared paths). */
  overlap: readonly string[];
  /**
   * Declarations of live peers that do NOT hold the lease. Reported in the
   * reason, never contention: a declaration is a plan, not a hold on the
   * branch, and a wait on it would only clear when the peer deregisters — two
   * peers that both declared `CHANGELOG.md` would wait on each other forever.
   */
  peerOverlap?: readonly PeerOverlap[];
  judged: JudgeVerdict | null;
  judgeConsulted: boolean;
}): { verdict: Verdict; decidedBy: DecidedBy; reason: string } {
  const peers = input.peerOverlap ?? [];
  const peerNote = peers.length > 0 ? ` ${describePeerOverlap(peers)}` : '';
  const contended = input.holderPresent || input.overlap.length > 0;
  if (!contended) {
    if (peers.length > 0) {
      return {
        verdict: 'allow',
        decidedBy: 'policy',
        reason:
          `No lease is held on this branch.${peerNote} A declaration does not hold the branch, so this is ` +
          'allowed; the peer integrates your change when it next merges the target.',
      };
    }
    return {
      verdict: 'allow',
      decidedBy: 'policy',
      reason: 'No lease is held on this branch and no declared paths overlap.',
    };
  }
  if (input.judged && !(input.holderPresent && input.judged.verdict === 'allow')) {
    return { verdict: input.judged.verdict, decidedBy: 'llm', reason: `${input.judged.reason}${peerNote}` };
  }
  const parts: string[] = [];
  if (input.holderPresent) parts.push('another worktree holds the lease on this branch');
  if (input.overlap.length > 0) {
    const shown = input.overlap.slice(0, 5).join(', ');
    parts.push(
      `${input.overlap.length} changed path${input.overlap.length === 1 ? '' : 's'} overlap the holder (${shown}${
        input.overlap.length > 5 ? ', …' : ''
      })`,
    );
  }
  const fallbackNote = input.judged?.verdict === 'allow' && input.holderPresent
    ? ' The arbiter cannot grant a second lease before the holder releases.'
    : input.judgeConsulted
    ? ' Decided by policy because no arbiter was reachable.'
    : '';
  return {
    verdict: 'wait',
    decidedBy: 'policy',
    reason: `Wait: ${parts.join('; ')}.${fallbackNote}${peerNote}`,
  };
}

/** One sentence naming each overlapping peer worktree and the paths it declared. */
function describePeerOverlap(peers: readonly PeerOverlap[]): string {
  const total = new Set(peers.flatMap((peer) => peer.paths)).size;
  const shown = peers.slice(0, 3).map((peer) => {
    const who = `${peer.username}${peer.branch ? ` on ${peer.branch}` : ''}`;
    const paths = peer.paths.slice(0, 5).join(', ');
    return `${peer.worktree_path} (${who}): ${paths}${peer.paths.length > 5 ? ', …' : ''}`;
  });
  const more = peers.length > 3 ? `; and ${peers.length - 3} more` : '';
  return (
    `${total} changed path${total === 1 ? '' : 's'} overlap paths declared by ` +
    `${peers.length} active peer worktree${peers.length === 1 ? '' : 's'}: ${shown.join('; ')}${more}.`
  );
}
