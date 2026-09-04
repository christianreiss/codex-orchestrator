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
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  agentBusAddresses,
  agentSessions,
  gitClones,
  gitMergeRequests,
  gitWorktrees,
  hosts,
  type GitClone,
  type GitMergeRequest,
  type GitWorktree,
  type Host,
} from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { AGENT_PRESENCE_FRESH_SECONDS, deriveAddressPresence, isPresent } from './agent-presence.js';
import { nowIso, isoOffsetSeconds, parseIso } from '../util/timestamp.js';
import { isEngine } from '../util/engine.js';
import type { SettingsService } from './settings.js';
import { wsPublisher } from '../ws/publisher.js';

/** The `versions` row that switches the whole module on. Absent means off. */
export const GIT_DIRECTOR_ENABLED_FLAG = 'git_director_enabled';
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
}

// ── pure helpers (exported for unit tests) ───────────────────────────────────

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Collapse the spellings of one remote onto one string.
 *
 * `git@host:org/repo.git` and `https://host/org/repo` are the same repository
 * and must hash the same, or cross-host grouping silently never groups — a
 * failure with no error and no symptom beyond clones that stubbornly refuse to
 * appear related. Strips scheme and userinfo, lowercases the host, and drops a
 * trailing `.git` and any trailing slash.
 */
export function normalizeRemote(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let rest = value;
  // scheme://  or  scp-like  user@host:path
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
  } else {
    const scp = /^([^/@]+@)?([^/:]+):(.+)$/.exec(rest);
    if (scp) rest = `${scp[2]}/${scp[3]}`;
  }
  const at = rest.indexOf('@');
  const firstSlash = rest.indexOf('/');
  // userinfo only counts before the first path separator
  if (at !== -1 && (firstSlash === -1 || at < firstSlash)) rest = rest.slice(at + 1);
  const slash = rest.indexOf('/');
  let host = slash === -1 ? rest : rest.slice(0, slash);
  let path = slash === -1 ? '' : rest.slice(slash + 1);
  host = host.toLowerCase().replace(/:\d+$/, '');
  // Order matters: a trailing slash has to go first, or `…/repo.git/` keeps its
  // `.git` and stops matching the same repo cloned over ssh. Strip again after,
  // since removing the suffix can expose another separator.
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return path ? `${host}/${path}` : host;
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

export class GitDirectorService {
  private readonly now: () => string;

  constructor(private readonly deps: GitDirectorServiceDeps) {
    this.now = deps.now ?? nowIso;
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
    const cloneRows = await this.deps.db.select({ id: gitClones.id }).from(gitClones).where(isNull(gitClones.archivedAt));
    const worktreeRows = await this.deps.db
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
    await this.deps.settings.setFlag(GIT_DIRECTOR_ENABLED_FLAG, enabled, { publish: false });
    wsPublisher.publish('settings.changed', { kind: 'git_director', enabled });
    wsPublisher.publish('git_director.changed', { kind: 'state', enabled });
    return await this.adminState();
  }

  /** How many live clones this host can see. Used by the AGENTS.md renderer. */
  async availableCount(host: Host | null): Promise<number> {
    const rows = await this.deps.db
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
   * `sweepCallPinsLocked` in agent-messaging.ts — a timer nobody can observe is
   * worse than work done by whoever next looks.
   *
   * Nothing is deleted. An expired registration keeps its row so `git_list` and
   * the console can still show that somebody WAS here and when they were last
   * seen; a registration that silently disappeared would read as an empty clone,
   * which is a worse lie than a stale one.
   */
  private async sweepExpired(db: GitDirectorDb, now: string): Promise<void> {
    const active = (
      await db
        .select({
          id: gitWorktrees.id,
          expiresAt: gitWorktrees.expiresAt,
          status: gitWorktrees.status,
          agentBusAddressId: gitWorktrees.agentBusAddressId,
        })
        .from(gitWorktrees)
        .where(eq(gitWorktrees.status, 'active'))
    ).filter((row) => row.status === 'active');

    const dead = await this.deadAddressIds(
      db,
      active.map((row) => row.agentBusAddressId).filter((id): id is string => Boolean(id)),
      now,
    );

    const abandoned = active.filter(
      (row) => row.agentBusAddressId !== null && dead.has(row.agentBusAddressId),
    );
    // TTL only bites where there is no address to ask. A bound-but-live agent is
    // working quietly between calls and must not be evicted for being silent.
    const timedOut = active.filter(
      (row) =>
        !abandoned.includes(row) &&
        (row.agentBusAddressId === null || !dead.has(row.agentBusAddressId)) &&
        isExpired(row.expiresAt, now),
    );

    if (abandoned.length > 0) {
      await db
        .update(gitWorktrees)
        .set({ status: 'abandoned', releasedAt: now, updatedAt: now })
        .where(inArray(gitWorktrees.id, abandoned.map((row) => row.id)));
    }
    if (timedOut.length > 0) {
      await db
        .update(gitWorktrees)
        .set({ status: 'expired', releasedAt: now, updatedAt: now })
        .where(inArray(gitWorktrees.id, timedOut.map((row) => row.id)));
    }

    const reclaimedWorktrees = new Set([...abandoned, ...timedOut].map((row) => row.id));

    const liveLeases = (
      await db
        .select({
          id: gitMergeRequests.id,
          worktreeId: gitMergeRequests.worktreeId,
          verdict: gitMergeRequests.verdict,
          completedAt: gitMergeRequests.completedAt,
          leaseExpiresAt: gitMergeRequests.leaseExpiresAt,
        })
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

    if (orphaned.length > 0) {
      await db
        .update(gitMergeRequests)
        .set({
          verdict: 'expired',
          completedAt: now,
          reason: 'Lease reclaimed: the holding agent is no longer registered in this clone.',
          updatedAt: now,
        })
        .where(inArray(gitMergeRequests.id, orphaned.map((row) => row.id)));
    }
    if (staleLeases.length > 0) {
      await db
        .update(gitMergeRequests)
        .set({
          verdict: 'expired',
          completedAt: now,
          reason: 'Lease expired: it was never renewed with git_merge_status and never released.',
          updatedAt: now,
        })
        .where(inArray(gitMergeRequests.id, staleLeases.map((row) => row.id)));
    }
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
  private async deadAddressIds(db: GitDirectorDb, ids: readonly string[], now: string): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    try {
      const rows = await db
        .select({
          id: agentBusAddresses.id,
          currentSessionId: agentBusAddresses.currentSessionId,
          lastUpstreamSessionId: agentBusAddresses.lastUpstreamSessionId,
          receiveHeartbeatAt: agentBusAddresses.receiveHeartbeatAt,
          enabled: agentBusAddresses.enabled,
          archivedAt: agentBusAddresses.archivedAt,
          readiness: agentBusAddresses.readiness,
          // Left, not inner: a reaped binding has no session row, and that
          // absence is the answer rather than a reason to drop the address.
          session: { heartbeatAt: agentSessions.heartbeatAt, endedAt: agentSessions.endedAt },
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
      return new Set();
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
  async register(args: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const now = this.now();
    const worktreePath = normalizePath(requiredString(args, 'worktree_path'));
    const cloneDir = normalizePath(optionalString(args, 'clone_dir') ?? worktreePath);
    const repoRoot = normalizePath(optionalString(args, 'repo_root') ?? worktreePath);
    const remoteUrl = optionalString(args, 'remote_url');
    const branch = optionalString(args, 'branch', 255);
    const headSha = optionalString(args, 'head_sha', 64);
    const username = optionalString(args, 'username', 255) ?? 'unknown';
    const engineRaw = optionalString(args, 'engine', 16);
    const engine = isEngine(engineRaw) ? engineRaw : null;

    const cloneKey = sha256(cloneDir);
    const worktreeHash = sha256(worktreePath);
    const remoteKey = normalizeRemote(remoteUrl);

    return await this.deps.db.transaction(async (tx) => {
      await this.sweepExpired(tx, now);

      const clone = await this.upsertCloneLocked(tx, {
        host,
        cloneKey,
        cloneDir,
        repoRoot,
        remoteUrl,
        remoteKey: remoteKey ? sha256(remoteKey) : null,
        now,
      });

      const address = await this.resolveAddress(tx, host, username, engine, worktreePath);
      const existing = (
        await tx
          .select()
          .from(gitWorktrees)
          .where(and(eq(gitWorktrees.cloneId, clone.id), eq(gitWorktrees.worktreeHash, worktreeHash)))
          .limit(1)
          .for('update')
      ).find((row) => row.cloneId === clone.id && row.worktreeHash === worktreeHash);

      const expiresAt = isoOffsetSeconds(REGISTRATION_TTL_SECONDS, new Date(now));
      if (!existing) {
        const id = randomUUID();
        await tx.insert(gitWorktrees).values({
          id,
          cloneId: clone.id,
          hostId: host.id,
          worktreePath,
          worktreeHash,
          username,
          engine,
          agentBusAddressId: address?.id ?? null,
          branch,
          headSha,
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
        wsPublisher.publish('git_director.changed', { kind: 'worktree', clone_id: clone.id });
        return {
          registered: true,
          rebound: false,
          clone: this.cloneWire(clone, host),
          worktree_id: id,
          worktree_path: worktreePath,
          expires_at: expiresAt,
          peers: await this.peerWire(tx, clone.id, id, now),
        };
      }

      const rebound =
        existing.username !== username ||
        (address?.id ?? null) !== (existing.agentBusAddressId ?? null);
      if (rebound && existing.status === 'active' && !isExpired(existing.expiresAt, now)) {
        const lease = await this.liveLeaseForWorktree(tx, existing.id, now);
        if (lease) {
          throw new ConflictError(
            'That worktree is registered to another live agent and currently holds a merge lease; ' +
              'have the holder call git_release, or wait for the lease to expire.',
            'git_director_lease_held',
          );
        }
      }

      await tx
        .update(gitWorktrees)
        .set({
          username,
          engine,
          agentBusAddressId: address?.id ?? null,
          branch,
          headSha,
          worktreePath,
          status: 'active',
          heartbeatAt: now,
          expiresAt,
          releasedAt: null,
          updatedAt: now,
        })
        .where(eq(gitWorktrees.id, existing.id));
      wsPublisher.publish('git_director.changed', { kind: 'worktree', clone_id: clone.id });
      return {
        registered: true,
        rebound,
        clone: this.cloneWire(clone, host),
        worktree_id: existing.id,
        worktree_path: worktreePath,
        expires_at: expiresAt,
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
    const paths = cleanPaths(args.paths);

    return await this.deps.db.transaction(async (tx) => {
      await this.sweepExpired(tx, now);
      const { clone, worktree } = await this.requireWorktree(tx, host, worktreePath, now);
      const expiresAt = isoOffsetSeconds(REGISTRATION_TTL_SECONDS, new Date(now));
      await tx
        .update(gitWorktrees)
        .set({
          task: task ?? worktree.task,
          targetBranch: targetBranch ?? worktree.targetBranch,
          declaredPaths: paths.length > 0 ? paths : worktree.declaredPaths,
          status: 'active',
          heartbeatAt: now,
          expiresAt,
          updatedAt: now,
        })
        .where(eq(gitWorktrees.id, worktree.id));
      wsPublisher.publish('git_director.changed', { kind: 'worktree', clone_id: clone.id });
      return {
        joined: true,
        clone: this.cloneWire(clone, host),
        worktree_id: worktree.id,
        task: task ?? worktree.task,
        target_branch: targetBranch ?? worktree.targetBranch,
        declared_paths: paths.length > 0 ? paths : readPaths(worktree.declaredPaths),
        expires_at: expiresAt,
        peers: await this.peerWire(tx, clone.id, worktree.id, now),
      };
    });
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  /**
   * What is going on. Host-scoped by default because that is the question an
   * agent actually has ("who else is in my checkout"); `fleet` widens it to every
   * host, and `clone` narrows to one.
   */
  async list(args: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const now = this.now();
    const scopeRaw = String(args.scope ?? 'host').trim().toLowerCase();
    const scope = scopeRaw === 'fleet' || scopeRaw === 'clone' ? scopeRaw : 'host';
    const worktreePath = optionalString(args, 'worktree_path');

    // Watching counts as working. An agent that polls git_list to see whether a
    // peer has appeared is plainly still alive, and reaping it for "going quiet"
    // while it is looking straight at us would be the exact failure this feature
    // is supposed to prevent. Heartbeat first, THEN sweep, so the refresh cannot
    // lose a race with the reaper it is meant to outrun. Any scope: an agent
    // asking a fleet-wide question is no less present than one asking about its
    // own clone.
    if (worktreePath) {
      const normalized = normalizePath(worktreePath);
      try {
        await this.deps.db.transaction(async (tx) => {
          await this.requireWorktree(tx, host, normalized, now);
        });
      } catch {
        // An unregistered path is not an error here — git_list is how an agent
        // looks around BEFORE it registers, and refusing that would invert the
        // order the guidance tells it to work in.
      }
    }

    await this.sweepExpired(this.deps.db, now);

    const allClones = await this.deps.db.select().from(gitClones);
    const hostRows = await this.deps.db.select({ id: hosts.id, fqdn: hosts.fqdn }).from(hosts);
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

    const out: Array<Record<string, unknown>> = [];
    for (const clone of clones.slice(0, 100)) {
      out.push({
        ...this.cloneWire(clone, null),
        fqdn: fqdnById.get(clone.hostId) ?? null,
        worktrees: await this.worktreeWire(this.deps.db, clone.id, now),
        leases: await this.leaseWire(this.deps.db, clone.id, now),
        stale: await this.staleWire(this.deps.db, clone.id, now),
      });
    }
    return { scope, clones: out, count: out.length };
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

    const decision = await this.deps.db.transaction(async (tx) => {
      await this.sweepExpired(tx, now);
      const { clone, worktree } = await this.requireWorktree(tx, host, worktreePath, now);

      // Skipped when re-deciding: the row we are about to update carries this
      // very `client_request_id`, so the retry guard would find itself and
      // short-circuit into "replayed" — a poll that could never change its own
      // verdict.
      const replay = updateRequestId !== null ? undefined : (
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
      ).find(
        (row) => row.worktreeId === worktree.id && row.clientRequestId === clientRequestId,
      );
      if (replay) {
        return { clone, worktree, request: replay, replayed: true, brief: null as MergeBrief | null };
      }

      // Lock the clone row: this is what makes the lease exclusive. MySQL has no
      // partial unique index, and this codebase uses row locks rather than
      // advisory locks everywhere else.
      await tx.select().from(gitClones).where(eq(gitClones.id, clone.id)).limit(1).for('update');

      const holderRow = await this.liveLeaseForClone(tx, clone.id, targetBranch, now);
      const queued = await this.queuedForClone(tx, clone.id, targetBranch, now, updateRequestId);
      const holderWorktree = holderRow
        ? (await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, holderRow.worktreeId)).limit(1)).find(
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
      return { clone, worktree, request: null as GitMergeRequest | null, replayed: false, brief };
    });

    if (decision.replayed && decision.request) {
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

    return await this.deps.db.transaction(async (tx) => {
      const now2 = this.now();
      const { clone, worktree } = decision;
      await tx.select().from(gitClones).where(eq(gitClones.id, clone.id)).limit(1).for('update');

      // Re-read under the lock: the holder may have released while the judge ran.
      const holderRow = await this.liveLeaseForClone(tx, clone.id, targetBranch, now2);
      const queued = await this.queuedForClone(tx, clone.id, targetBranch, now2, updateRequestId);
      const holderWorktree = holderRow
        ? (await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, holderRow.worktreeId)).limit(1)).find(
            (row) => row.id === holderRow.worktreeId,
          ) ?? null
        : null;
      const holderPaths = holderRow
        ? [...readPaths(holderRow.changedPaths), ...readPaths(holderWorktree?.declaredPaths)]
        : [];
      const overlap = overlappingPaths(changedPaths, holderPaths);

      const existing =
        updateRequestId === null
          ? null
          : (
              await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.id, updateRequestId)).limit(1)
            ).find((row) => row.id === updateRequestId) ?? null;

      const resolved = resolveVerdict({
        holderPresent: Boolean(holderRow),
        overlap,
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
        completedAt: null,
        createdAt: existing?.createdAt ?? now2,
        updatedAt: now2,
      };
      if (updateRequestId !== null) {
        // Re-decide in place. `requestedAt` is deliberately preserved: it is when
        // the caller first asked, which is what queue order and "how long has
        // this been waiting" both depend on.
        await tx
          .update(gitMergeRequests)
          .set({
            verdict: resolved.verdict,
            decidedBy: resolved.decidedBy,
            reason: resolved.reason,
            overlap: overlap.length > 0 ? overlap : null,
            holderWorktreeId: holderRow?.worktreeId ?? null,
            model: resolved.decidedBy === 'llm' ? model : null,
            leaseExpiresAt,
            decidedAt: now2,
            renewedAt: now2,
            updatedAt: now2,
          })
          .where(eq(gitMergeRequests.id, updateRequestId));
        await tx
          .update(gitWorktrees)
          .set({ heartbeatAt: now2, updatedAt: now2 })
          .where(eq(gitWorktrees.id, worktree.id));
        wsPublisher.publish('git_director.changed', { kind: 'merge_request', clone_id: clone.id });
        return this.requestWire(row as unknown as GitMergeRequest, {
          replayed: false,
          holder: holderWorktree,
          queueDepth: queued.length,
        });
      }
      try {
        await tx.insert(gitMergeRequests).values(row);
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
        if (winner) return this.requestWire(winner, { replayed: true });
        throw new ConflictError('Merge request could not be recorded', 'git_director_conflict');
      }

      await tx
        .update(gitWorktrees)
        .set({ targetBranch, heartbeatAt: now2, updatedAt: now2 })
        .where(eq(gitWorktrees.id, worktree.id));
      wsPublisher.publish('git_director.changed', { kind: 'merge_request', clone_id: clone.id });

      return this.requestWire(row as unknown as GitMergeRequest, {
        replayed: false,
        holder: holderWorktree,
        queueDepth: queued.length,
      });
    });
  }

  /**
   * Re-decide a `wait`, or renew a live lease.
   *
   * Promotion is poll-driven by design: releasing a lease pushes nothing to
   * whoever is waiting, and the next call here re-decides against the now-free
   * branch. That falls out of the lease-as-a-row model and keeps the Director
   * free of any outbound delivery path.
   */
  async mergeStatus(args: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const requestId = requiredString(args, 'request_id', 36);
    const now = this.now();

    const current = await this.deps.db.transaction(async (tx) => {
      await this.sweepExpired(tx, now);
      const request = await this.requireRequest(tx, requestId, host);
      if (request.verdict === 'allow' && !request.completedAt) {
        const leaseExpiresAt = isoOffsetSeconds(LEASE_TTL_SECONDS, new Date(now));
        await tx
          .update(gitMergeRequests)
          .set({ leaseExpiresAt, renewedAt: now, updatedAt: now })
          .where(eq(gitMergeRequests.id, request.id));
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
    if (!requestId && !worktreePath) {
      throw new ValidationError('request_id or worktree_path is required', { param: 'request_id' });
    }

    return await this.deps.db.transaction(async (tx) => {
      await this.sweepExpired(tx, now);
      let released = 0;
      let cloneId: string | null = null;

      if (requestId) {
        const request = await this.requireRequest(tx, requestId, host);
        cloneId = request.cloneId;
        if (!request.completedAt) {
          await tx
            .update(gitMergeRequests)
            .set({ verdict: 'withdrawn', completedAt: now, updatedAt: now })
            .where(eq(gitMergeRequests.id, request.id));
          released += 1;
        }
      }

      if (worktreePath) {
        const { clone, worktree } = await this.requireWorktree(tx, host, normalizePath(worktreePath), now);
        cloneId = clone.id;
        const live = await this.liveRequestsForWorktree(tx, worktree.id, now);
        if (live.length > 0) {
          await tx
            .update(gitMergeRequests)
            .set({ verdict: 'withdrawn', completedAt: now, updatedAt: now })
            .where(inArray(gitMergeRequests.id, live.map((row) => row.id)));
          released += live.length;
        }
        if (deregister) {
          await tx
            .update(gitWorktrees)
            .set({ status: 'released', releasedAt: now, updatedAt: now })
            .where(eq(gitWorktrees.id, worktree.id));
        }
      }

      if (cloneId) wsPublisher.publish('git_director.changed', { kind: 'release', clone_id: cloneId });
      return { released, deregistered: deregister };
    });
  }

  // ── admin surface ─────────────────────────────────────────────────────────

  async adminClones(): Promise<Array<Record<string, unknown>>> {
    const now = this.now();
    await this.sweepExpired(this.deps.db, now);
    const clones = (await this.deps.db.select().from(gitClones)).filter((row) => !row.archivedAt);
    const hostRows = await this.deps.db.select({ id: hosts.id, fqdn: hosts.fqdn }).from(hosts);
    const fqdnById = new Map(hostRows.map((row) => [row.id, row.fqdn]));
    clones.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
    const out: Array<Record<string, unknown>> = [];
    for (const clone of clones) {
      out.push({
        ...this.cloneWire(clone, null),
        fqdn: fqdnById.get(clone.hostId) ?? null,
        worktrees: await this.worktreeWire(this.deps.db, clone.id, now),
        leases: await this.leaseWire(this.deps.db, clone.id, now),
        stale: await this.staleWire(this.deps.db, clone.id, now),
        recent: await this.recentWire(this.deps.db, clone.id),
      });
    }
    return out;
  }

  /**
   * Operator force-allow / force-deny from the console. Writes
   * `decided_by: 'operator'` so the audit trail never attributes a human's call
   * to the model.
   */
  async adminDecide(requestId: string, verdict: 'allow' | 'deny', reason: string | null): Promise<Record<string, unknown>> {
    const now = this.now();
    if (verdict !== 'allow' && verdict !== 'deny') {
      throw new ValidationError('verdict must be "allow" or "deny"', { param: 'verdict' });
    }
    return await this.deps.db.transaction(async (tx) => {
      const rows = await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.id, requestId)).limit(1).for('update');
      const request = rows.find((row) => row.id === requestId);
      if (!request) throw new NotFoundError('Merge request not found', 'git_director_request_not_found');
      const leaseExpiresAt = verdict === 'allow' ? isoOffsetSeconds(LEASE_TTL_SECONDS, new Date(now)) : null;
      await tx
        .update(gitMergeRequests)
        .set({
          verdict,
          decidedBy: 'operator',
          reason: reason?.trim() || `Forced ${verdict} by an operator from the console.`,
          leaseExpiresAt,
          decidedAt: now,
          completedAt: verdict === 'deny' ? now : null,
          updatedAt: now,
        })
        .where(eq(gitMergeRequests.id, requestId));
      wsPublisher.publish('git_director.changed', { kind: 'decision', clone_id: request.cloneId });
      const updated = (await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.id, requestId)).limit(1)).find(
        (row) => row.id === requestId,
      );
      return this.requestWire(updated ?? request, {});
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
    return await this.deps.db.transaction(async (tx) => {
      const rows = await tx.select().from(gitWorktrees).where(eq(gitWorktrees.id, worktreeId)).limit(1).for('update');
      const worktree = rows.find((row) => row.id === worktreeId);
      if (!worktree) throw new NotFoundError('Worktree not found', 'git_director_worktree_not_found');

      const live = await this.liveRequestsForWorktree(tx, worktree.id, now);
      if (live.length > 0) {
        await tx
          .update(gitMergeRequests)
          .set({
            verdict: 'withdrawn',
            completedAt: now,
            reason: 'Withdrawn: an operator evicted the holding registration from the console.',
            updatedAt: now,
          })
          .where(inArray(gitMergeRequests.id, live.map((row) => row.id)));
      }
      await tx
        .update(gitWorktrees)
        .set({ status: 'released', releasedAt: now, updatedAt: now })
        .where(eq(gitWorktrees.id, worktree.id));
      wsPublisher.publish('git_director.changed', { kind: 'evict', clone_id: worktree.cloneId });
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
    const rows = await tx
      .select()
      .from(gitClones)
      .where(and(eq(gitClones.hostId, input.host.id), eq(gitClones.cloneKey, input.cloneKey)))
      .limit(1)
      .for('update');
    const existing = rows.find(
      (row) => row.hostId === input.host.id && row.cloneKey === input.cloneKey,
    );
    if (existing) {
      await tx
        .update(gitClones)
        .set({
          repoRoot: input.repoRoot,
          remoteUrl: input.remoteUrl ?? existing.remoteUrl,
          remoteKey: input.remoteKey ?? existing.remoteKey,
          lastSeenAt: input.now,
          archivedAt: null,
          updatedAt: input.now,
        })
        .where(eq(gitClones.id, existing.id));
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
    await tx.insert(gitClones).values(clone);
    wsPublisher.publish('git_director.changed', { kind: 'clone', clone_id: clone.id });
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
    username: string,
    engine: string | null,
    worktreePath: string,
  ): Promise<{ id: string } | null> {
    if (!engine) return null;
    const cwdHash = sha256(worktreePath);
    try {
      const rows = await tx
        .select({
          id: agentBusAddresses.id,
          hostId: agentBusAddresses.hostId,
          engine: agentBusAddresses.engine,
          username: agentBusAddresses.username,
          cwdHash: agentBusAddresses.cwdHash,
          archivedAt: agentBusAddresses.archivedAt,
        })
        .from(agentBusAddresses)
        .where(and(eq(agentBusAddresses.hostId, host.id), eq(agentBusAddresses.cwdHash, cwdHash)))
        .limit(4);
      return (
        rows.find(
          (row) =>
            row.hostId === host.id &&
            row.cwdHash === cwdHash &&
            row.engine === engine &&
            row.username === username &&
            !row.archivedAt,
        ) ?? null
      );
    } catch {
      // Agent Messaging tables may not exist on a box mid-deploy. Enrichment is
      // optional by construction, so a miss must never fail a registration.
      return null;
    }
  }

  private async cloneForWorktree(
    tx: GitDirectorDb,
    host: Host,
    worktreePath: string,
  ): Promise<GitClone | null> {
    const worktreeHash = sha256(worktreePath);
    const rows = await tx
      .select()
      .from(gitWorktrees)
      .where(and(eq(gitWorktrees.hostId, host.id), eq(gitWorktrees.worktreeHash, worktreeHash)))
      .limit(4);
    const worktree = rows.find((row) => row.hostId === host.id && row.worktreeHash === worktreeHash);
    if (!worktree) return null;
    const clones = await tx.select().from(gitClones).where(eq(gitClones.id, worktree.cloneId)).limit(1);
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
    const worktreeHash = sha256(worktreePath);
    const rows = await tx
      .select()
      .from(gitWorktrees)
      .where(and(eq(gitWorktrees.hostId, host.id), eq(gitWorktrees.worktreeHash, worktreeHash)))
      .limit(4);
    const worktree = rows.find((row) => row.hostId === host.id && row.worktreeHash === worktreeHash);
    if (!worktree) {
      throw new NotFoundError(
        `No registration for ${worktreePath}. Call git_register for this worktree first.`,
        'git_director_worktree_not_found',
      );
    }
    const clones = await tx.select().from(gitClones).where(eq(gitClones.id, worktree.cloneId)).limit(1);
    const clone = clones.find((row) => row.id === worktree.cloneId);
    if (!clone) throw new NotFoundError('Clone not found', 'git_director_clone_not_found');

    const expiresAt = isoOffsetSeconds(REGISTRATION_TTL_SECONDS, new Date(now));
    await tx
      .update(gitWorktrees)
      .set({ status: 'active', heartbeatAt: now, expiresAt, releasedAt: null, updatedAt: now })
      .where(eq(gitWorktrees.id, worktree.id));
    return {
      clone,
      worktree: { ...worktree, status: 'active', heartbeatAt: now, expiresAt, releasedAt: null },
    };
  }

  private async requireRequest(tx: GitDirectorDb, requestId: string, host: Host): Promise<GitMergeRequest> {
    const rows = await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.id, requestId)).limit(1);
    const request = rows.find((row) => row.id === requestId);
    if (!request) throw new NotFoundError('Merge request not found', 'git_director_request_not_found');
    const clones = await tx.select().from(gitClones).where(eq(gitClones.id, request.cloneId)).limit(1);
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
  ): Promise<GitMergeRequest | null> {
    const rows = await tx
      .select()
      .from(gitMergeRequests)
      .where(and(eq(gitMergeRequests.cloneId, cloneId), eq(gitMergeRequests.verdict, 'allow')))
      .limit(200);
    return (
      rows.find(
        (row) =>
          row.cloneId === cloneId &&
          row.verdict === 'allow' &&
          row.targetBranch === targetBranch &&
          !row.completedAt &&
          !isExpired(row.leaseExpiresAt, now),
      ) ?? null
    );
  }

  private async liveLeaseForWorktree(
    tx: GitDirectorDb,
    worktreeId: string,
    now: string,
  ): Promise<GitMergeRequest | null> {
    const rows = await tx
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
    const rows = await tx
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
    const rows = await tx
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
    const rows = (await tx.select().from(gitWorktrees).where(eq(gitWorktrees.cloneId, cloneId)).limit(200)).filter(
      (row) => row.cloneId === cloneId && row.status === 'active' && !isExpired(row.expiresAt, now),
    );
    rows.sort((a, b) => (a.worktreePath < b.worktreePath ? -1 : 1));
    return rows.map((row) => ({
      worktree_id: row.id,
      worktree_path: row.worktreePath,
      username: row.username,
      engine: row.engine,
      branch: row.branch,
      head_sha: row.headSha,
      task: row.task,
      declared_paths: readPaths(row.declaredPaths),
      target_branch: row.targetBranch,
      agent_address_bound: Boolean(row.agentBusAddressId),
      heartbeat_at: row.heartbeatAt,
      expires_at: row.expiresAt,
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
    const rows = (await tx.select().from(gitWorktrees).where(eq(gitWorktrees.cloneId, cloneId)).limit(200)).filter(
      (row) => row.cloneId === cloneId && (row.status === 'expired' || row.status === 'abandoned'),
    );
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
    const rows = (
      await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.cloneId, cloneId)).limit(200)
    ).filter((row) => row.cloneId === cloneId && !row.completedAt && (row.verdict === 'allow' || row.verdict === 'wait'));
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
    const rows = (
      await tx
        .select()
        .from(gitMergeRequests)
        .where(eq(gitMergeRequests.cloneId, cloneId))
        .orderBy(desc(gitMergeRequests.requestedAt))
        .limit(25)
    ).filter((row) => row.cloneId === cloneId);
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

  private requestWire(
    request: GitMergeRequest,
    extra: { replayed?: boolean; renewed?: boolean; holder?: GitWorktree | null; queueDepth?: number },
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {
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
  overlap: readonly string[];
  judged: JudgeVerdict | null;
  judgeConsulted: boolean;
}): { verdict: Verdict; decidedBy: DecidedBy; reason: string } {
  const contended = input.holderPresent || input.overlap.length > 0;
  if (!contended) {
    return {
      verdict: 'allow',
      decidedBy: 'policy',
      reason: 'No lease is held on this branch and no declared paths overlap.',
    };
  }
  if (input.judged) {
    return { verdict: input.judged.verdict, decidedBy: 'llm', reason: input.judged.reason };
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
  const fallbackNote = input.judgeConsulted
    ? ' Decided by policy because no arbiter was reachable.'
    : '';
  return {
    verdict: 'wait',
    decidedBy: 'policy',
    reason: `Wait: ${parts.join('; ')}.${fallbackNote}`,
  };
}
