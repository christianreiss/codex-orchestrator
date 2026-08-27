/**
 * The project board: cards as the unit of coordinated work, with claim/lease
 * semantics mirroring the Git Director.
 *
 * A todo is a checkbox. A card is a claim — it records who is working on it, in
 * what capacity, since when, and until when. That last part is the whole point:
 * an agent that dies mid-task calls nothing, and a flat list has no way to
 * notice. Here the claim expires, and where Agent Messaging bound an address to
 * it the board can see the agent is gone within seconds instead of waiting out a
 * TTL.
 *
 * ADVISORY, like everything else the orchestrator says about machines it cannot
 * see. Moving a card into a lane your role does not match still moves the card;
 * the response and the recorded event carry an advisory and a `logs` row records
 * it. Exceeding a WIP limit is the same. The single thing the board declines to
 * do is record a claim somebody else already holds, and that is a fact about
 * this table rather than a restriction on the agent — nothing stops it working,
 * it just will not be able to tell everyone else that the card is its own.
 *
 * THE TRANSACTION INVARIANT, which is not optional:
 *
 *   1. `SELECT latest_event_seq FROM coord_projects … FOR UPDATE`
 *   2. `SELECT … FROM coord_project_cards … FOR UPDATE`
 *   3. decide — on refusal, return HERE, consuming no seq and writing no event
 *   4. mutate the card, bump the seq, insert the event
 *   5. commit, and only then publish
 *
 * Step 1 is both the event-seq allocator and the per-project mutex; MySQL has no
 * partial unique index, so a row lock is what makes a claim exclusive, the same
 * choice `git_merge_requests` makes. Step 3 matters more than it looks: writing
 * an event for a refused claim would mean a polling agent floods the project's
 * change log with its own rejections. And every event here goes through
 * `HostProjectsService._recordEventTx` rather than its `recordEvent`, because
 * that one opens its own transaction and would block on a different pool
 * connection until `innodb_lock_wait_timeout` — 50 seconds, intermittent, under
 * exactly the contention this feature exists for.
 *
 * Card movements are not stored here. Every create, move, claim, release and
 * reclaim is a `coord_project_events` row with `entity_type = 'card'`, so board
 * activity reaches the `project_changes` poll agents already run, and the board
 * needs no history table of its own.
 */
import { randomUUID, createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  agentBusAddresses,
  coordProjectBoardColumns,
  coordProjectBoards,
  coordProjectCards,
  coordProjectEvents,
  coordProjects,
  hosts,
  logs,
  type CoordProjectBoardColumn,
  type CoordProjectCard,
  type Host,
} from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { isoOffsetSeconds, nowIso, parseIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import type { SettingsService } from './settings.js';
import type { HostProjectsService, ProjectEventTx } from './host-projects.js';
import { normalizeProjectBoardRole, PROJECT_BOARD_ROLES } from './project-board-roles.js';

/** The `versions` row that switches the whole module on. Absent means off. */
export const PROJECT_BOARD_ENABLED_FLAG = 'project_board_enabled';

/**
 * How long a claim survives without being renewed. Renewal is implicit: any call
 * naming the card by its holder pushes it out again, so an agent that keeps
 * working keeps its card without a heartbeat of its own. Thirty minutes is long
 * enough that a slow build does not lose a card and short enough that a crashed
 * agent with no bound address does not wedge one for a shift.
 */
export const CARD_CLAIM_TTL_SECONDS = 1800;

export const DEFAULT_BOARD_SLUG = 'default';

const MAX_TITLE = 255;
const MAX_DETAIL = 32000;
const MAX_LABELS = 16;
const MAX_LABEL_LENGTH = 64;
const MAX_BLOCKED_REASON = 500;
const MAX_NOTE_LENGTH = 1000;
/** Cap on cards rendered per lane, so one enormous backlog cannot bloat a tool result. */
const MAX_CARDS_PER_COLUMN = 200;
const RECENT_EVENTS = 20;

export type ProjectBoardDb = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

/**
 * The seeded lanes, which must stay in step with the backfill in
 * `migrations/0026_add_project_board.sql`. They are duplicated rather than
 * shared because SQL cannot import TypeScript; `project-board.test.ts` pins the
 * two spellings against each other so a divergence fails the build.
 *
 * `ops` deliberately has no lane of its own — it is the role that acts on the
 * open ones, where `allowedRoles` is null.
 */
export const SEEDED_COLUMNS: readonly {
  key: string;
  title: string;
  allowedRoles: string[] | null;
  next: string | null;
  isIntake?: boolean;
  isTerminal?: boolean;
  isBlocked?: boolean;
}[] = [
  { key: 'backlog', title: 'Backlog', allowedRoles: null, next: 'planning', isIntake: true },
  { key: 'planning', title: 'Planning', allowedRoles: ['plan'], next: 'coding' },
  { key: 'coding', title: 'Coding', allowedRoles: ['code'], next: 'review' },
  { key: 'review', title: 'Review', allowedRoles: ['review'], next: 'verifying' },
  { key: 'verifying', title: 'Verifying', allowedRoles: ['verify'], next: 'done' },
  { key: 'done', title: 'Done', allowedRoles: null, next: null, isTerminal: true },
  { key: 'blocked', title: 'Blocked', allowedRoles: null, next: null, isBlocked: true },
];

// ── pure helpers (exported for unit tests) ───────────────────────────────────

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface Advisory {
  code: string;
  message: string;
}

/**
 * A card reference as an agent may spell it: the UUID, or the per-project card
 * number, as a string or a number. Returning both as null is what the caller
 * turns into a ValidationError; guessing would resolve `"seventeen"` to card 0.
 */
export function normalizeCardRef(raw: unknown): { id: string | null; number: number | null } {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return { id: null, number: raw };
  }
  const text = String(raw ?? '').trim();
  if (!text) return { id: null, number: null };
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(text)) {
    return { id: text.toLowerCase(), number: null };
  }
  // `#17` is how the board renders a card, so accept how it reads.
  const digits = text.startsWith('#') ? text.slice(1) : text;
  if (/^\d+$/.test(digits)) {
    const value = Number(digits);
    if (Number.isSafeInteger(value) && value > 0) return { id: null, number: value };
  }
  return { id: null, number: null };
}

export interface ClaimState {
  role: string | null;
  hostId: number | null;
  username: string | null;
  worktreeHash: string | null;
  clientRequestId: string | null;
  claimedAt: string | null;
  expiresAt: string | null;
  releasedAt: string | null;
}

export interface ClaimRequester {
  hostId: number | null;
  username: string | null;
  worktreeHash: string | null;
  clientRequestId: string | null;
}

export type ClaimDecision =
  /** Nobody holds it. */
  | { outcome: 'granted' }
  /** The same actor already holds it; extend rather than mint a second claim. */
  | { outcome: 'renewed' }
  /** The same client_request_id against a live claim: a retried tool call. */
  | { outcome: 'retry' }
  /** Somebody else holds it, and the board will not say otherwise. */
  | { outcome: 'held' };

/** A claim is live while it has not been released and has not run out. */
export function claimIsLive(state: ClaimState | null, now: string): boolean {
  if (!state || state.releasedAt || !state.claimedAt) return false;
  if (!state.expiresAt) return false;
  const expires = parseIso(state.expiresAt);
  const at = parseIso(now);
  if (!expires || !at) return false;
  return expires.getTime() > at.getTime();
}

/**
 * Who gets the card. The `retry` arm exists for the same reason
 * `uq_git_merge_requests_client` does: MCP tool calls get retried and models
 * re-call tools on ambiguous results, and without it a retry reads as a second
 * contender for a card the caller already holds. It is honoured only against a
 * LIVE claim, so a stale request id cannot resurrect one that was released.
 */
export function resolveClaim(
  state: ClaimState | null,
  requester: ClaimRequester,
  now: string,
): ClaimDecision {
  if (!claimIsLive(state, now)) return { outcome: 'granted' };
  const live = state!;
  if (
    requester.clientRequestId &&
    live.clientRequestId &&
    requester.clientRequestId === live.clientRequestId
  ) {
    return { outcome: 'retry' };
  }
  const sameActor =
    live.hostId !== null &&
    live.hostId === requester.hostId &&
    (live.username ?? null) === (requester.username ?? null) &&
    (live.worktreeHash ?? null) === (requester.worktreeHash ?? null);
  return sameActor ? { outcome: 'renewed' } : { outcome: 'held' };
}

export interface AdvisoryColumn {
  key: string;
  title: string;
  allowedRoles: string[] | null;
  wipLimit: number | null;
}

/**
 * What is wrong with this move, without stopping it.
 *
 * A missing role produces nothing: admin moves from the console have no role to
 * declare, and advising on every one of them would train readers to ignore the
 * field. Only a role that was declared and does not match is worth saying out
 * loud, because that is a claim about capacity the board can check.
 */
export function columnAdvisories(input: {
  role: string | null;
  column: AdvisoryColumn;
  occupancy: number;
}): Advisory[] {
  const advisories: Advisory[] = [];
  const allowed = input.column.allowedRoles;
  if (input.role && allowed && allowed.length > 0 && !allowed.includes(input.role)) {
    advisories.push({
      code: 'role_not_allowed',
      message: `"${input.column.title}" expects ${allowed.join(' or ')}; this card was moved by ${input.role}.`,
    });
  }
  const limit = input.column.wipLimit;
  if (limit !== null && limit > 0 && input.occupancy + 1 > limit) {
    advisories.push({
      code: 'wip_limit_exceeded',
      message: `"${input.column.title}" has a WIP limit of ${limit} and would hold ${input.occupancy + 1}.`,
    });
  }
  return advisories;
}

export interface ReleaseColumn {
  id: string;
  defaultNextColumnId: string | null;
}

/**
 * Where a released card lands. Precedence, highest first:
 *
 *   1. a column the caller named — an explicit instruction always wins
 *   2. `resolution: 'handoff'` — stay put, because a handoff means somebody else
 *      picks this card up where it is, not that the work advanced
 *   3. `resolution: 'blocked'` — the blocked lane
 *   4. `resolution: 'done'` — the terminal lane
 *   5. the current column's `default_next_column_id` — the auto-advance, which
 *      is what a bare release does
 *   6. the current column, when the chain ends there
 *
 * This exact order is repeated in `project_card_release`'s tool description. An
 * agent that has to guess it will guess wrong, and a card that silently did not
 * move is the kind of wrong nobody notices until the board is stale.
 */
export function resolveReleaseTarget(input: {
  current: ReleaseColumn;
  requestedColumnId: string | null;
  resolution: CardResolution | null;
  terminalColumnId: string | null;
  blockedColumnId: string | null;
}): string {
  if (input.requestedColumnId) return input.requestedColumnId;
  if (input.resolution === 'handoff') return input.current.id;
  if (input.resolution === 'blocked' && input.blockedColumnId) return input.blockedColumnId;
  if (input.resolution === 'done' && input.terminalColumnId) return input.terminalColumnId;
  return input.current.defaultNextColumnId ?? input.current.id;
}

export const CARD_RESOLUTIONS = ['done', 'blocked', 'handoff'] as const;
export type CardResolution = (typeof CARD_RESOLUTIONS)[number];

export function normalizeResolution(value: unknown): CardResolution | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return (CARD_RESOLUTIONS as readonly string[]).includes(text) ? (text as CardResolution) : null;
}

// ── argument coercion ────────────────────────────────────────────────────────

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const raw = args[key];
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  return text.length > 0 ? text : null;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new ValidationError(`${key} is required`, { param: key });
  return value;
}

function boundedText(value: string, max: number, param: string): string {
  if (value.length > max) throw new ValidationError(`${param} exceeds ${max} characters`, { param });
  return value;
}

function normalizeLabels(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new ValidationError('labels must be an array', { param: 'labels' });
  const labels: string[] = [];
  for (const entry of raw) {
    const text = String(entry ?? '').trim();
    if (!text) continue;
    if (text.length > MAX_LABEL_LENGTH) {
      throw new ValidationError(`label exceeds ${MAX_LABEL_LENGTH} characters`, { param: 'labels' });
    }
    if (!labels.includes(text)) labels.push(text);
  }
  if (labels.length > MAX_LABELS) {
    throw new ValidationError(`at most ${MAX_LABELS} labels`, { param: 'labels' });
  }
  return labels;
}

function jsonStringArray(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(value)) return null;
  const list = value.map((entry) => String(entry)).filter((entry) => entry.length > 0);
  return list.length > 0 ? list : null;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── the service ──────────────────────────────────────────────────────────────

export interface ProjectBoardServiceDeps {
  db: Database;
  projects: HostProjectsService;
  /**
   * Optional, because the `project_todo_*` shim runs through this service and
   * must keep working whether or not the board module is switched on. Todos
   * predate the flag; turning the board off hides its tools and its page, and
   * has never been a reason for a todo call to start failing. Only
   * `getEnabled`/`adminState`/`setEnabled` need it, and only the routes that own
   * the switch pass it.
   */
  settings?: SettingsService;
  now?: () => string;
}

/** The `project_todo_*` wire shape, unchanged from before the board existed. */
export interface ProjectTodoWire {
  id: number;
  project_id: number;
  title: string;
  detail: string;
  done: boolean;
  done_at: string | null;
  source_host_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ProjectBoardModuleState {
  enabled: boolean;
  boards: number;
  cards: number;
  claimed: number;
  updated_at: string | null;
}

/** The identity a card mutation is attributed to. */
export interface CardActor {
  hostId: number | null;
  username: string | null;
  engine: string | null;
  worktreePath: string | null;
}

export function actorFromHost(host: Host, args: Record<string, unknown>, engine?: string | null): CardActor {
  return {
    hostId: host.id,
    username: optionalString(args, 'username'),
    engine: engine ?? null,
    worktreePath: optionalString(args, 'worktree_path'),
  };
}

/** The console has no worktree and no role; it acts as the operator. */
export const OPERATOR_ACTOR: CardActor = {
  hostId: null,
  username: null,
  engine: null,
  worktreePath: null,
};

type ProjectRow = Awaited<ReturnType<HostProjectsService['requireProject']>>;

interface PendingPublish {
  event: string;
  payload: Record<string, unknown>;
}

interface BoardContext {
  tx: ProjectEventTx & ProjectBoardDb;
  project: ProjectRow;
  boardId: string;
  columns: ColumnRow[];
  now: string;
  actor: CardActor;
  publishes: PendingPublish[];
}

type ColumnRow = CoordProjectBoardColumn;

export class ProjectBoardService {
  private readonly now: () => string;

  constructor(private readonly deps: ProjectBoardServiceDeps) {
    this.now = deps.now ?? nowIso;
  }

  // ── module switch ─────────────────────────────────────────────────────────

  async getEnabled(): Promise<boolean> {
    if (!this.deps.settings) return false;
    return await this.deps.settings.getFlag(PROJECT_BOARD_ENABLED_FLAG, false);
  }

  private requireSettings(): SettingsService {
    if (!this.deps.settings) throw new Error('ProjectBoardService was built without a settings service');
    return this.deps.settings;
  }

  async adminState(): Promise<ProjectBoardModuleState> {
    const meta = await this.requireSettings().getWithMeta(PROJECT_BOARD_ENABLED_FLAG);
    const boardRows = await this.deps.db
      .select({ id: coordProjectBoards.id })
      .from(coordProjectBoards)
      .where(isNull(coordProjectBoards.archivedAt));
    const cardRows = await this.deps.db
      .select({
        id: coordProjectCards.id,
        claimedAt: coordProjectCards.claimedAt,
        claimExpiresAt: coordProjectCards.claimExpiresAt,
        claimReleasedAt: coordProjectCards.claimReleasedAt,
        archivedAt: coordProjectCards.archivedAt,
      })
      .from(coordProjectCards);
    const now = this.now();
    const live = cardRows.filter((row) => !row.archivedAt);
    return {
      enabled: await this.getEnabled(),
      boards: boardRows.length,
      cards: live.length,
      claimed: live.filter((row) =>
        claimIsLive(
          {
            role: null,
            hostId: null,
            username: null,
            worktreeHash: null,
            clientRequestId: null,
            claimedAt: row.claimedAt,
            expiresAt: row.claimExpiresAt,
            releasedAt: row.claimReleasedAt,
          },
          now,
        ),
      ).length,
      updated_at: meta.updatedAt,
    };
  }

  async setEnabled(enabled: boolean): Promise<ProjectBoardModuleState> {
    await this.requireSettings().setFlag(PROJECT_BOARD_ENABLED_FLAG, enabled, { publish: false });
    wsPublisher.publish('settings.changed', { kind: 'project_board', enabled });
    wsPublisher.publish('project_board.module_toggled', { enabled });
    return await this.adminState();
  }

  // ── board provisioning ────────────────────────────────────────────────────

  /**
   * The board for a project, created on first touch.
   *
   * Migration 0026 seeds one for every project that existed when it ran, but a
   * project created afterwards has none — and putting the seed in
   * `createProject` would leave the board depending on a code path the admin and
   * host services each have their own copy of. Provisioning here means every
   * entry point gets the same board whether or not anyone remembered.
   */
  private async ensureBoard(
    tx: ProjectBoardDb,
    project: ProjectRow,
    now: string,
  ): Promise<{ boardId: string; columns: ColumnRow[] }> {
    const existing = await tx
      .select()
      .from(coordProjectBoards)
      .where(
        and(
          eq(coordProjectBoards.projectId, project.id),
          eq(coordProjectBoards.slug, DEFAULT_BOARD_SLUG),
        ),
      )
      .limit(1);

    let boardId = existing[0]?.id ?? null;
    if (!boardId) {
      boardId = randomUUID();
      await tx.insert(coordProjectBoards).values({
        id: boardId,
        projectId: project.id,
        slug: DEFAULT_BOARD_SLUG,
        title: 'Board',
        nextCardNumber: 1,
        claimTtlSeconds: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    let columns = await this.fetchColumns(tx, boardId);
    if (columns.length === 0) {
      const ids = new Map<string, string>();
      for (const seed of SEEDED_COLUMNS) ids.set(seed.key, randomUUID());
      for (const [position, seed] of SEEDED_COLUMNS.entries()) {
        await tx.insert(coordProjectBoardColumns).values({
          id: ids.get(seed.key)!,
          boardId,
          projectId: project.id,
          columnKey: seed.key,
          title: seed.title,
          position,
          wipLimit: null,
          allowedRoles: seed.allowedRoles,
          defaultNextColumnId: seed.next ? (ids.get(seed.next) ?? null) : null,
          isIntake: seed.isIntake ? 1 : 0,
          isTerminal: seed.isTerminal ? 1 : 0,
          isBlocked: seed.isBlocked ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      columns = await this.fetchColumns(tx, boardId);
    }
    return { boardId, columns };
  }

  private async fetchColumns(tx: ProjectBoardDb, boardId: string): Promise<ColumnRow[]> {
    const rows = await tx
      .select()
      .from(coordProjectBoardColumns)
      .where(eq(coordProjectBoardColumns.boardId, boardId))
      .orderBy(asc(coordProjectBoardColumns.position));
    return [...rows].sort((a, b) => a.position - b.position);
  }

  /**
   * Two intake columns is an operator error rather than a corruption — MySQL
   * cannot express a partial unique index, so nothing prevents it. Lowest
   * `position` wins, consistently, in every lane lookup.
   */
  private pickFlagged(columns: ColumnRow[], flag: 'isIntake' | 'isTerminal' | 'isBlocked'): ColumnRow | null {
    return columns.filter((column) => column[flag] === 1).sort((a, b) => a.position - b.position)[0] ?? null;
  }

  private intakeColumn(columns: ColumnRow[]): ColumnRow {
    const column = this.pickFlagged(columns, 'isIntake') ?? columns[0];
    if (!column) throw new NotFoundError('This board has no columns');
    return column;
  }

  // ── claim sweep ───────────────────────────────────────────────────────────

  /**
   * Reclaim the cards forgotten clients left claimed, and record that they were
   * forgotten rather than finished.
   *
   * An agent that vanishes mid-card is the normal case: a closed terminal, a
   * killed wrapper, a session that simply ended. None of those release anything.
   * Two independent signals, and using only the second is the mistake to avoid:
   *
   *  1. **Definitive death.** Where Agent Messaging bound an address to the
   *     claim, `agent_bus_addresses.current_session_id` is NULL exactly when no
   *     wrapper is attached. That is the fleet's own liveness, reused rather
   *     than reinvented, and it frees the card in seconds.
   *  2. **Silence.** With Agent Messaging off there is no address to ask, so the
   *     TTL is all that is left. It is the fallback, never the primary.
   *
   * A bound-and-live agent whose claim has NOT expired is never touched, and
   * neither is one that is quietly working between calls — its next call renews
   * it. Reclaims DO record an event, unlike refused claims: they are rare, and a
   * card that silently became free reads as one nobody ever wanted.
   */
  private async sweepClaims(
    tx: ProjectEventTx,
    project: ProjectRow,
    now: string,
  ): Promise<CoordProjectCard[]> {
    const candidates = (
      await tx
        .select()
        .from(coordProjectCards)
        .where(and(eq(coordProjectCards.projectId, project.id), isNull(coordProjectCards.claimReleasedAt)))
    ).filter((card) => card.claimedAt !== null && card.claimReleasedAt === null);
    if (candidates.length === 0) return [];

    const boundIds = candidates
      .map((card) => card.claimedAgentBusAddressId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const dead = await this.deadAddressIds(tx, boundIds);

    const reclaimed: CoordProjectCard[] = [];
    for (const card of candidates) {
      const bound = card.claimedAgentBusAddressId;
      const isDead = bound !== null && dead.has(bound);
      const expired = !claimIsLive(this.claimStateOf(card), now);
      if (!isDead && !expired) continue;
      const reason = isDead
        ? 'Claim reclaimed: the holding agent is no longer running.'
        : 'Claim expired: it was never renewed and never released.';
      await tx
        .update(coordProjectCards)
        .set({ claimReleasedAt: now, claimReleaseReason: reason, updatedAt: now })
        .where(eq(coordProjectCards.id, card.id));
      reclaimed.push({ ...card, claimReleasedAt: now, claimReleaseReason: reason });
      await this.deps.projects._recordEventTx(
        tx,
        project,
        'card',
        'claim_expired',
        'card',
        card.id,
        {
          card_id: card.id,
          card_number: Number(card.cardNumber),
          title: card.title,
          role: card.claimRole,
          username: card.claimedByUsername,
          reason,
        },
        card.claimedByHostId ?? null,
        now,
      );
    }
    return reclaimed;
  }

  /**
   * Which of these bound addresses no longer have a live agent behind them.
   *
   * Failing open is deliberate, and copied from the Git Director: if the Agent
   * Messaging tables cannot be read — a box mid-deploy, the module never
   * installed — nobody is reported dead and every claim falls back to its TTL.
   * Guessing "dead" on a failed read would free cards out from under agents that
   * are working on them.
   */
  private async deadAddressIds(tx: ProjectBoardDb, ids: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    try {
      const rows = await tx
        .select({
          id: agentBusAddresses.id,
          currentSessionId: agentBusAddresses.currentSessionId,
          enabled: agentBusAddresses.enabled,
          archivedAt: agentBusAddresses.archivedAt,
          readiness: agentBusAddresses.readiness,
        })
        .from(agentBusAddresses)
        .where(inArray(agentBusAddresses.id, unique))
        .limit(Math.max(unique.length, 1));
      const known = new Map(rows.map((row) => [row.id, row]));
      const dead = new Set<string>();
      for (const id of unique) {
        const row = known.get(id);
        // An id we bound and can no longer find has been purged; that is gone too.
        if (!row) {
          dead.add(id);
          continue;
        }
        if (row.archivedAt || row.enabled !== 1) dead.add(id);
        else if (!row.currentSessionId) dead.add(id);
        else if (row.readiness === 'offline' || row.readiness === 'disabled') dead.add(id);
      }
      return dead;
    } catch {
      return new Set();
    }
  }

  /**
   * Enrich a claim with the caller's bus address, when there is one to find.
   * Enrichment only: a miss leaves the claim on its TTL and must never fail it.
   */
  private async resolveAddress(
    tx: ProjectBoardDb,
    actor: CardActor,
  ): Promise<{ id: string } | null> {
    if (actor.hostId === null || !actor.engine || !actor.worktreePath || !actor.username) return null;
    const cwdHash = sha256(actor.worktreePath);
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
        .where(and(eq(agentBusAddresses.hostId, actor.hostId), eq(agentBusAddresses.cwdHash, cwdHash)))
        .limit(4);
      return (
        rows.find(
          (row) =>
            row.hostId === actor.hostId &&
            row.cwdHash === cwdHash &&
            row.engine === actor.engine &&
            row.username === actor.username &&
            !row.archivedAt,
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  private claimStateOf(card: CoordProjectCard): ClaimState {
    return {
      role: card.claimRole,
      hostId: card.claimedByHostId === null ? null : Number(card.claimedByHostId),
      username: card.claimedByUsername,
      worktreeHash: card.claimedWorktreeHash,
      clientRequestId: card.claimClientRequestId,
      claimedAt: card.claimedAt,
      expiresAt: card.claimExpiresAt,
      releasedAt: card.claimReleasedAt,
    };
  }

  private requesterOf(actor: CardActor, clientRequestId: string | null): ClaimRequester {
    return {
      hostId: actor.hostId,
      username: actor.username,
      worktreeHash: actor.worktreePath ? sha256(actor.worktreePath) : null,
      clientRequestId,
    };
  }

  // ── the mutation frame ────────────────────────────────────────────────────

  /**
   * Run one card operation under the invariant this file's header states: lock
   * the project row, provision the board, renew this caller's claims, sweep what
   * died, then decide. Everything the operation wants published is collected and
   * flushed AFTER the commit, because a subscriber that reacts to an event by
   * reading the row must not be able to read it before it exists.
   *
   * Renewal runs BEFORE the sweep on purpose. An agent whose thirty minutes are
   * nearly up and which is calling right now is working, and a reaper that ran
   * first would take its card away in the same transaction that proves it is
   * alive. This is the same ordering `git_list` uses, for the same reason:
   * watching is proof of life. Renewal only touches claims that already exist —
   * polling must never mint a row.
   */
  private async withBoard<T>(
    slug: string,
    actor: CardActor,
    run: (ctx: BoardContext) => Promise<T>,
  ): Promise<T> {
    const project = await this.deps.projects.requireProject(slug);
    const now = this.now();
    const publishes: PendingPublish[] = [];
    const value = await this.deps.db.transaction(async (tx) => {
      // THE lock. Everything below — provisioning, renewal, the sweep, and the
      // decision itself — happens while this transaction holds the project row,
      // which is what makes two concurrent claims on one card resolve to exactly
      // one winner. `_recordEventTx` re-takes it for free, but relying on that
      // alone would leave the refusal path unserialised: a refused claim writes
      // no event, so it would never lock anything and two callers could each
      // read "unclaimed" before either wrote.
      await tx
        .select({ seq: coordProjects.latestEventSeq })
        .from(coordProjects)
        .where(eq(coordProjects.id, project.id))
        .for('update');
      const { boardId, columns } = await this.ensureBoard(tx, project, now);
      await this.renewActorClaims(tx, project, actor, now, boardId);
      const reclaimed = await this.sweepClaims(tx, project, now);
      for (const card of reclaimed) {
        publishes.push({ event: 'project.card.released', payload: { slug: project.slug, card_id: card.id, reclaimed: true } });
      }
      return await run({ tx, project, boardId, columns, now, actor, publishes });
    });
    for (const pending of publishes) wsPublisher.publish(pending.event, pending.payload);
    return value;
  }

  /**
   * Record a card event inside the caller's transaction and queue the two
   * publishes that go with it. Never use `HostProjectsService.recordEvent` here
   * — see this file's header.
   */
  private async emit(
    ctx: BoardContext,
    action: string,
    card: { id: string; cardNumber: number | bigint },
    payload: Record<string, unknown>,
    event: string,
  ): Promise<void> {
    const seq = await this.deps.projects._recordEventTx(
      ctx.tx,
      ctx.project,
      'card',
      action,
      'card',
      card.id,
      payload,
      ctx.actor.hostId,
      ctx.now,
    );
    ctx.publishes.push({
      event: 'project.changed',
      payload: { slug: ctx.project.slug, seq, event_type: 'card', action, source_host_id: ctx.actor.hostId },
    });
    ctx.publishes.push({
      event,
      payload: {
        slug: ctx.project.slug,
        card_id: card.id,
        card_number: Number(card.cardNumber),
        source_host_id: ctx.actor.hostId,
      },
    });
  }

  private async log(hostId: number | null, action: string, details: Record<string, unknown>): Promise<void> {
    await this.deps.db.insert(logs).values({
      hostId: hostId ?? null,
      action,
      details: JSON.stringify(details),
      createdAt: this.now(),
      engine: null,
    });
  }

  /**
   * Push this caller's live claims out by another TTL. Updates only; a caller
   * with nothing claimed changes nothing, and an unidentifiable caller (the
   * console, or an agent that sent no `worktree_path`) is skipped entirely
   * rather than matched loosely — renewing somebody else's claim because two
   * agents share a host would be worse than letting one expire.
   */
  private async renewActorClaims(
    tx: ProjectBoardDb,
    project: ProjectRow,
    actor: CardActor,
    now: string,
    boardId: string,
  ): Promise<void> {
    if (actor.hostId === null || !actor.worktreePath || !actor.username) return;
    const hash = sha256(actor.worktreePath);
    const held = (
      await tx
        .select()
        .from(coordProjectCards)
        .where(and(eq(coordProjectCards.projectId, project.id), isNull(coordProjectCards.claimReleasedAt)))
    ).filter(
      (card) =>
        card.claimedByHostId === actor.hostId &&
        card.claimedByUsername === actor.username &&
        card.claimedWorktreeHash === hash &&
        claimIsLive(this.claimStateOf(card), now),
    );
    if (held.length === 0) return;
    const expires = await this.claimExpiry(tx, boardId, now);
    await tx
      .update(coordProjectCards)
      .set({ claimExpiresAt: expires, updatedAt: now })
      .where(inArray(coordProjectCards.id, held.map((card) => card.id)));
  }

  private async claimExpiry(tx: ProjectBoardDb, boardId: string, now: string): Promise<string> {
    const rows = await tx
      .select({ ttl: coordProjectBoards.claimTtlSeconds })
      .from(coordProjectBoards)
      .where(eq(coordProjectBoards.id, boardId))
      .limit(1);
    const ttl = rows[0]?.ttl ?? null;
    const seconds = ttl && ttl > 0 ? ttl : CARD_CLAIM_TTL_SECONDS;
    return isoOffsetSeconds(seconds, parseIso(now) ?? new Date());
  }

  // ── card lookup ───────────────────────────────────────────────────────────

  private async cardsOf(tx: ProjectBoardDb, projectId: number): Promise<CoordProjectCard[]> {
    const rows = await tx
      .select()
      .from(coordProjectCards)
      .where(eq(coordProjectCards.projectId, projectId))
      .orderBy(desc(coordProjectCards.priority), asc(coordProjectCards.enteredColumnAt));
    return rows.filter((row) => !row.archivedAt);
  }

  private async requireCard(
    tx: ProjectBoardDb,
    projectId: number,
    ref: unknown,
    lock: boolean,
  ): Promise<CoordProjectCard> {
    const { id, number } = normalizeCardRef(ref);
    if (!id && number === null) {
      throw new ValidationError('card must be a card number or a card id', { param: 'card' });
    }
    const where = id
      ? and(eq(coordProjectCards.projectId, projectId), eq(coordProjectCards.id, id))
      : and(eq(coordProjectCards.projectId, projectId), eq(coordProjectCards.cardNumber, number!));
    const query = tx.select().from(coordProjectCards).where(where).limit(1);
    // Locking the card as well as the project is belt-and-braces, but it is the
    // same order every time, which is what keeps it from being a deadlock.
    const rows = lock ? await query.for('update') : await query;
    const card = rows[0];
    if (!card || card.archivedAt) throw new NotFoundError('Card not found');
    return card;
  }

  private async allocateCardNumber(tx: ProjectBoardDb, boardId: string, now: string): Promise<number> {
    const rows = await tx
      .select({ next: coordProjectBoards.nextCardNumber })
      .from(coordProjectBoards)
      .where(eq(coordProjectBoards.id, boardId))
      .limit(1);
    const next = Number(rows[0]?.next ?? 1) || 1;
    await tx
      .update(coordProjectBoards)
      .set({ nextCardNumber: next + 1, updatedAt: now })
      .where(eq(coordProjectBoards.id, boardId));
    return next;
  }

  // ── wire rendering ────────────────────────────────────────────────────────

  private columnWire(column: ColumnRow): Record<string, unknown> {
    return {
      id: column.id,
      key: column.columnKey,
      title: column.title,
      position: column.position,
      wip_limit: column.wipLimit,
      allowed_roles: jsonStringArray(column.allowedRoles),
      default_next_column_id: column.defaultNextColumnId,
      is_intake: column.isIntake === 1,
      is_terminal: column.isTerminal === 1,
      is_blocked: column.isBlocked === 1,
    };
  }

  private claimWire(
    card: CoordProjectCard,
    now: string,
    actor: CardActor,
    hostLabels: Map<number, string>,
  ): Record<string, unknown> | null {
    const state = this.claimStateOf(card);
    if (!claimIsLive(state, now)) {
      return card.claimReleaseReason
        ? { held: false, released_at: card.claimReleasedAt, release_reason: card.claimReleaseReason }
        : null;
    }
    const hash = actor.worktreePath ? sha256(actor.worktreePath) : null;
    return {
      held: true,
      role: card.claimRole,
      username: card.claimedByUsername,
      host_id: card.claimedByHostId === null ? null : Number(card.claimedByHostId),
      host: card.claimedByHostId === null ? null : (hostLabels.get(Number(card.claimedByHostId)) ?? null),
      worktree_path: card.claimedWorktreePath,
      claimed_at: card.claimedAt,
      expires_at: card.claimExpiresAt,
      agent_address_bound: card.claimedAgentBusAddressId !== null,
      yours:
        card.claimedByHostId !== null &&
        Number(card.claimedByHostId) === actor.hostId &&
        card.claimedByUsername === actor.username &&
        card.claimedWorktreeHash === hash,
    };
  }

  private cardWire(
    card: CoordProjectCard,
    columns: ColumnRow[],
    now: string,
    actor: CardActor,
    hostLabels: Map<number, string>,
  ): Record<string, unknown> {
    const column = columns.find((entry) => entry.id === card.columnId) ?? null;
    return {
      id: card.id,
      number: Number(card.cardNumber),
      title: card.title,
      detail: card.detail,
      labels: jsonStringArray(card.labels) ?? [],
      priority: card.priority,
      blocked_reason: card.blockedReason,
      column: column ? { id: column.id, key: column.columnKey, title: column.title } : null,
      claim: this.claimWire(card, now, actor, hostLabels),
      entered_column_at: card.enteredColumnAt,
      created_at: card.createdAt,
      updated_at: card.updatedAt,
    };
  }

  /** fqdn lookup for the holder line, so "held by chris on crane" is possible. */
  private async hostLabels(tx: ProjectBoardDb, ids: readonly (number | null)[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter((id): id is number => typeof id === 'number'))];
    if (unique.length === 0) return new Map();
    try {
      const rows = await tx
        .select({ id: hosts.id, fqdn: hosts.fqdn })
        .from(hosts)
        .where(inArray(hosts.id, unique))
        .limit(Math.max(unique.length, 1));
      return new Map(rows.map((row) => [Number(row.id), row.fqdn]));
    } catch {
      return new Map();
    }
  }

  private capabilities(enabled: boolean): Record<string, boolean> {
    return {
      list: true,
      create: enabled,
      claim: enabled,
      move: enabled,
      release: enabled,
      update: enabled,
      // Said out loud for the same reason the Git Director says
      // `enforce_merges: false`: an agent should not have to discover by
      // experiment that the board advises rather than blocks.
      enforce_roles: false,
      enforce_wip: false,
    };
  }

  // ── public operations ─────────────────────────────────────────────────────

  /**
   * The discovery entry point: what boards exist, what is in them, and who holds
   * what. Every argument is optional, so an agent that knows nothing can still
   * call it — the same shape `git_list` and `shared_memory_list` have, and for
   * the same reason: a tool you must already know something to call is not a
   * discovery tool.
   *
   * It never throws on a disabled module. `status: 'disabled'` with an empty
   * list is distinguishable from `status: 'available'` with an empty list, and
   * an agent that cannot tell those apart will report the wrong thing.
   */
  async listBoards(args: Record<string, unknown>, host: Host | null): Promise<Record<string, unknown>> {
    const enabled = await this.getEnabled();
    if (!enabled) {
      return {
        status: 'disabled',
        capabilities: this.capabilities(false),
        roles: [...PROJECT_BOARD_ROLES],
        boards: [],
        count: 0,
      };
    }
    const actor: CardActor = host
      ? actorFromHost(host, args, optionalString(args, 'engine'))
      : OPERATOR_ACTOR;
    const slug = optionalString(args, 'slug');
    const slugs = slug ? [slug] : await this.projectSlugs();

    const filters = {
      column: optionalString(args, 'column'),
      role: normalizeProjectBoardRole(args['role']),
      mine: args['mine'] === true,
      unclaimed: args['unclaimed'] === true,
    };

    const boards: Record<string, unknown>[] = [];
    for (const each of slugs) {
      try {
        boards.push(await this.withBoard(each, actor, (ctx) => this.renderBoard(ctx, filters)));
      } catch (error) {
        // A project deleted between listing and rendering is not an error for a
        // discovery call; an explicitly named one still is.
        if (slug) throw error;
      }
    }
    return {
      status: 'available',
      capabilities: this.capabilities(true),
      roles: [...PROJECT_BOARD_ROLES],
      boards,
      count: boards.length,
    };
  }

  private async projectSlugs(): Promise<string[]> {
    const rows = await this.deps.db
      .select({ slug: coordProjects.slug, archivedAt: coordProjects.archivedAt })
      .from(coordProjects)
      .orderBy(asc(coordProjects.slug));
    return rows.filter((row) => !row.archivedAt).map((row) => row.slug);
  }

  private async renderBoard(
    ctx: BoardContext,
    filters: { column: string | null; role: string | null; mine: boolean; unclaimed: boolean },
  ): Promise<Record<string, unknown>> {
    const cards = await this.cardsOf(ctx.tx, ctx.project.id);
    const labels = await this.hostLabels(
      ctx.tx,
      cards.map((card) => (card.claimedByHostId === null ? null : Number(card.claimedByHostId))),
    );

    const visible = cards.filter((card) => {
      const live = claimIsLive(this.claimStateOf(card), ctx.now);
      if (filters.unclaimed && live) return false;
      if (filters.role && card.claimRole !== filters.role) return false;
      if (filters.mine) {
        const wire = this.claimWire(card, ctx.now, ctx.actor, labels);
        if (!wire || wire['yours'] !== true) return false;
      }
      return true;
    });

    const columns = ctx.columns
      .filter((column) => !filters.column || column.columnKey === filters.column)
      .map((column) => {
        const inColumn = visible.filter((card) => card.columnId === column.id);
        const occupancy = cards.filter((card) => card.columnId === column.id).length;
        return {
          ...this.columnWire(column),
          card_count: occupancy,
          over_wip: column.wipLimit !== null && column.wipLimit > 0 && occupancy > column.wipLimit,
          cards: inColumn
            .slice(0, MAX_CARDS_PER_COLUMN)
            .map((card) => this.cardWire(card, ctx.columns, ctx.now, ctx.actor, labels)),
          truncated: inColumn.length > MAX_CARDS_PER_COLUMN,
        };
      });

    const yours = cards
      .filter((card) => {
        const wire = this.claimWire(card, ctx.now, ctx.actor, labels);
        return wire !== null && wire['yours'] === true;
      })
      .map((card) => this.cardWire(card, ctx.columns, ctx.now, ctx.actor, labels));

    // What the sweep took back, so an agent that lost a card to a reclaim can
    // see why rather than finding it mysteriously free.
    const reclaimed = cards
      .filter((card) => card.claimReleaseReason !== null && card.claimReleasedAt !== null)
      .sort((a, b) => String(b.claimReleasedAt).localeCompare(String(a.claimReleasedAt)))
      .slice(0, 10)
      .map((card) => ({
        id: card.id,
        number: Number(card.cardNumber),
        title: card.title,
        released_at: card.claimReleasedAt,
        reason: card.claimReleaseReason,
      }));

    return {
      project: ctx.project.slug,
      board_slug: DEFAULT_BOARD_SLUG,
      latest_seq: ctx.project.latest_event_seq,
      columns,
      your_claims: yours,
      reclaimed_recently: reclaimed,
    };
  }

  /** One card, its claim, and the tail of its own history. Also the renew surface. */
  async getCard(args: Record<string, unknown>, host: Host | null): Promise<Record<string, unknown>> {
    const slug = requiredString(args, 'slug');
    const actor = host ? actorFromHost(host, args, optionalString(args, 'engine')) : OPERATOR_ACTOR;
    return await this.withBoard(slug, actor, async (ctx) => {
      const card = await this.requireCard(ctx.tx, ctx.project.id, args['card'], false);
      const labels = await this.hostLabels(ctx.tx, [
        card.claimedByHostId === null ? null : Number(card.claimedByHostId),
      ]);
      const events = await ctx.tx
        .select()
        .from(coordProjectEvents)
        .where(
          and(
            eq(coordProjectEvents.projectId, ctx.project.id),
            eq(coordProjectEvents.entityType, 'card'),
            eq(coordProjectEvents.entityId, card.id),
          ),
        )
        .orderBy(desc(coordProjectEvents.seq))
        .limit(RECENT_EVENTS);
      return {
        project: ctx.project.slug,
        card: this.cardWire(card, ctx.columns, ctx.now, ctx.actor, labels),
        history: events.map((event) => ({
          seq: Number(event.seq),
          action: event.action,
          created_at: event.createdAt,
          source_host_id: event.sourceHostId === null ? null : Number(event.sourceHostId),
        })),
      };
    });
  }

  async createCard(args: Record<string, unknown>, host: Host | null): Promise<Record<string, unknown>> {
    const slug = requiredString(args, 'slug');
    const actor = host ? actorFromHost(host, args, optionalString(args, 'engine')) : OPERATOR_ACTOR;
    const title = boundedText(requiredString(args, 'title'), MAX_TITLE, 'title');
    const detail = boundedText(optionalString(args, 'detail') ?? '', MAX_DETAIL, 'detail');
    const labels = normalizeLabels(args['labels']);
    const priority = Number.isInteger(args['priority']) ? Number(args['priority']) : 0;

    const result = await this.withBoard(slug, actor, async (ctx) => {
      const requested = optionalString(args, 'column');
      const column = requested ? this.columnByRef(ctx.columns, requested) : this.intakeColumn(ctx.columns);
      const number = await this.allocateCardNumber(ctx.tx, ctx.boardId, ctx.now);
      const id = randomUUID();
      await ctx.tx.insert(coordProjectCards).values({
        id,
        projectId: ctx.project.id,
        boardId: ctx.boardId,
        columnId: column.id,
        cardNumber: number,
        title,
        detail,
        labels,
        priority,
        blockedReason: null,
        sourceTodoId: null,
        createdByHostId: actor.hostId,
        enteredColumnAt: ctx.now,
        archivedAt: null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      });
      await this.emit(
        ctx,
        'create',
        { id, cardNumber: number },
        { card_id: id, card_number: number, title, column: column.columnKey },
        'project.card.created',
      );
      const card = await this.requireCard(ctx.tx, ctx.project.id, id, false);
      return {
        project: ctx.project.slug,
        card: this.cardWire(card, ctx.columns, ctx.now, ctx.actor, new Map()),
      };
    });
    await this.log(actor.hostId, 'project.card.create', { slug, title });
    return result;
  }

  /**
   * Take the card, declaring what you are doing to it.
   *
   * The only operation on this board that can decline. It declines to RECORD,
   * not to permit: an agent is free to work on a card somebody else holds, and
   * the response says who to talk to rather than pretending the card does not
   * exist.
   */
  async claimCard(
    args: Record<string, unknown>,
    host: Host,
    engine?: string | null,
  ): Promise<Record<string, unknown>> {
    const slug = requiredString(args, 'slug');
    const actor = actorFromHost(host, args, engine ?? optionalString(args, 'engine'));
    const roleRaw = requiredString(args, 'role');
    const role = normalizeProjectBoardRole(roleRaw);
    if (!role) {
      throw new ValidationError(`role must be one of: ${PROJECT_BOARD_ROLES.join(', ')}`, { param: 'role' });
    }
    const clientRequestId = optionalString(args, 'client_request_id');
    const note = optionalString(args, 'note');
    if (note) boundedText(note, MAX_NOTE_LENGTH, 'note');

    return await this.withBoard(slug, actor, async (ctx) => {
      const card = await this.requireCard(ctx.tx, ctx.project.id, args['card'], true);
      const decision = resolveClaim(this.claimStateOf(card), this.requesterOf(actor, clientRequestId), ctx.now);
      const labels = await this.hostLabels(ctx.tx, [
        card.claimedByHostId === null ? null : Number(card.claimedByHostId),
      ]);

      if (decision.outcome === 'held') {
        // Refusing writes NOTHING. A polling agent must not be able to fill the
        // project's change log with its own rejections.
        const holder = this.claimWire(card, ctx.now, actor, labels);
        return {
          claimed: false,
          project: ctx.project.slug,
          card: this.cardWire(card, ctx.columns, ctx.now, actor, labels),
          holder,
          reason: this.holderReason(card, labels),
        };
      }

      if (decision.outcome === 'retry') {
        return {
          claimed: true,
          retried: true,
          project: ctx.project.slug,
          card: this.cardWire(card, ctx.columns, ctx.now, actor, labels),
          role: card.claimRole,
          expires_at: card.claimExpiresAt,
          advisories: [],
        };
      }

      const address = await this.resolveAddress(ctx.tx, actor);
      const expires = await this.claimExpiry(ctx.tx, ctx.boardId, ctx.now);
      const column = ctx.columns.find((entry) => entry.id === card.columnId) ?? null;
      const occupancy = (await this.cardsOf(ctx.tx, ctx.project.id)).filter(
        (entry) => entry.columnId === card.columnId && entry.id !== card.id,
      ).length;
      const advisories = column
        ? columnAdvisories({
            role,
            column: {
              key: column.columnKey,
              title: column.title,
              allowedRoles: jsonStringArray(column.allowedRoles),
              wipLimit: column.wipLimit,
            },
            occupancy,
          })
        : [];

      await ctx.tx
        .update(coordProjectCards)
        .set({
          claimRole: role,
          claimedByHostId: actor.hostId,
          claimedByUsername: actor.username,
          claimedWorktreePath: actor.worktreePath,
          claimedWorktreeHash: actor.worktreePath ? sha256(actor.worktreePath) : null,
          claimedAgentBusAddressId: address?.id ?? null,
          claimClientRequestId: clientRequestId,
          claimedAt: decision.outcome === 'renewed' ? (card.claimedAt ?? ctx.now) : ctx.now,
          claimExpiresAt: expires,
          claimReleasedAt: null,
          claimReleaseReason: null,
          updatedAt: ctx.now,
        })
        .where(eq(coordProjectCards.id, card.id));

      await this.emit(
        ctx,
        decision.outcome === 'renewed' ? 'claim_renew' : 'claim',
        card,
        {
          card_id: card.id,
          card_number: Number(card.cardNumber),
          title: card.title,
          role,
          username: actor.username,
          worktree_path: actor.worktreePath,
          expires_at: expires,
          note,
          advisories,
        },
        'project.card.claimed',
      );

      const fresh = await this.requireCard(ctx.tx, ctx.project.id, card.id, false);
      return {
        claimed: true,
        renewed: decision.outcome === 'renewed',
        project: ctx.project.slug,
        card: this.cardWire(fresh, ctx.columns, ctx.now, actor, labels),
        role,
        expires_at: expires,
        agent_address_bound: address !== null,
        advisories,
      };
    });
  }

  private holderReason(card: CoordProjectCard, labels: Map<number, string>): string {
    const who = card.claimedByUsername ?? 'another agent';
    const hostId = card.claimedByHostId === null ? null : Number(card.claimedByHostId);
    const where = hostId !== null ? (labels.get(hostId) ?? `host ${hostId}`) : 'an unknown host';
    const since = card.claimedAt ?? 'an unknown time';
    const until = card.claimExpiresAt ?? 'an unknown time';
    return (
      `Card #${Number(card.cardNumber)} "${card.title}" is claimed by ${who} on ${where} since ${since}, ` +
      `until ${until}. Take another card, or ask them to release it. Nothing stops you working on it anyway — ` +
      `the board simply will not record it as yours.`
    );
  }

  /** Move a card. Never refuses; a violation comes back as an advisory. */
  async moveCard(args: Record<string, unknown>, host: Host | null): Promise<Record<string, unknown>> {
    const slug = requiredString(args, 'slug');
    const actor = host ? actorFromHost(host, args, optionalString(args, 'engine')) : OPERATOR_ACTOR;
    const target = requiredString(args, 'column');
    const role = normalizeProjectBoardRole(args['role']);
    const note = optionalString(args, 'note');
    if (note) boundedText(note, MAX_NOTE_LENGTH, 'note');

    return await this.withBoard(slug, actor, async (ctx) => {
      const card = await this.requireCard(ctx.tx, ctx.project.id, args['card'], true);
      const column = this.columnByRef(ctx.columns, target);
      const from = ctx.columns.find((entry) => entry.id === card.columnId) ?? null;
      const result = await this.applyMove(ctx, card, column, role, note, null);
      return {
        project: ctx.project.slug,
        card: result.card,
        from_column: from ? { key: from.columnKey, title: from.title } : null,
        to_column: { key: column.columnKey, title: column.title },
        advisories: result.advisories,
      };
    });
  }

  /**
   * The shared body of a move, used by `moveCard` and by `releaseCard`'s
   * auto-advance so the two cannot drift on advisories, WIP accounting or what
   * entering a terminal lane does to a claim.
   */
  private async applyMove(
    ctx: BoardContext,
    card: CoordProjectCard,
    column: ColumnRow,
    role: string | null,
    note: string | null,
    blockedReason: string | null,
  ): Promise<{ card: Record<string, unknown>; advisories: Advisory[] }> {
    const occupancy = (await this.cardsOf(ctx.tx, ctx.project.id)).filter(
      (entry) => entry.columnId === column.id && entry.id !== card.id,
    ).length;
    const advisories =
      card.columnId === column.id
        ? []
        : columnAdvisories({
            role,
            column: {
              key: column.columnKey,
              title: column.title,
              allowedRoles: jsonStringArray(column.allowedRoles),
              wipLimit: column.wipLimit,
            },
            occupancy,
          });

    // Landing in the terminal lane ends the claim: a card nobody is working on
    // any more must not keep a lease that would have to expire on its own.
    const terminal = column.isTerminal === 1;
    await ctx.tx
      .update(coordProjectCards)
      .set({
        columnId: column.id,
        enteredColumnAt: card.columnId === column.id ? card.enteredColumnAt : ctx.now,
        blockedReason: column.isBlocked === 1 ? (blockedReason ?? card.blockedReason) : null,
        ...(terminal
          ? { claimReleasedAt: ctx.now, claimReleaseReason: 'Card reached a terminal column.' }
          : {}),
        updatedAt: ctx.now,
      })
      .where(eq(coordProjectCards.id, card.id));

    await this.emit(
      ctx,
      'move',
      card,
      {
        card_id: card.id,
        card_number: Number(card.cardNumber),
        title: card.title,
        from: ctx.columns.find((entry) => entry.id === card.columnId)?.columnKey ?? null,
        to: column.columnKey,
        role,
        note,
        advisories,
      },
      'project.card.moved',
    );

    for (const advisory of advisories) {
      await this.log(ctx.actor.hostId, 'project.card.advisory', {
        slug: ctx.project.slug,
        card_id: card.id,
        card_number: Number(card.cardNumber),
        column: column.columnKey,
        role,
        code: advisory.code,
        message: advisory.message,
      });
    }

    const fresh = await this.requireCard(ctx.tx, ctx.project.id, card.id, false);
    return {
      card: this.cardWire(fresh, ctx.columns, ctx.now, ctx.actor, new Map()),
      advisories,
    };
  }

  /**
   * Give the card back, and advance it. Precedence is `resolveReleaseTarget`'s,
   * and it is spelled out in the tool description because an agent that guesses
   * it wrong leaves a card that looks finished sitting where it started.
   */
  async releaseCard(args: Record<string, unknown>, host: Host | null): Promise<Record<string, unknown>> {
    const slug = requiredString(args, 'slug');
    const actor = host ? actorFromHost(host, args, optionalString(args, 'engine')) : OPERATOR_ACTOR;
    const resolution = normalizeResolution(args['resolution']);
    if (args['resolution'] !== undefined && args['resolution'] !== null && !resolution) {
      throw new ValidationError(`resolution must be one of: ${CARD_RESOLUTIONS.join(', ')}`, {
        param: 'resolution',
      });
    }
    const note = optionalString(args, 'note');
    if (note) boundedText(note, MAX_NOTE_LENGTH, 'note');
    const requestedColumn = optionalString(args, 'column');

    return await this.withBoard(slug, actor, async (ctx) => {
      const card = await this.requireCard(ctx.tx, ctx.project.id, args['card'], true);
      const current = ctx.columns.find((entry) => entry.id === card.columnId) ?? null;
      if (!current) throw new NotFoundError('Card is not in any column of this board');

      const targetId = resolveReleaseTarget({
        current: { id: current.id, defaultNextColumnId: current.defaultNextColumnId },
        requestedColumnId: requestedColumn ? this.columnByRef(ctx.columns, requestedColumn).id : null,
        resolution,
        terminalColumnId: this.pickFlagged(ctx.columns, 'isTerminal')?.id ?? null,
        blockedColumnId: this.pickFlagged(ctx.columns, 'isBlocked')?.id ?? null,
      });
      const target = ctx.columns.find((entry) => entry.id === targetId) ?? current;

      const moved =
        target.id === current.id
          ? null
          : await this.applyMove(
              ctx,
              card,
              target,
              card.claimRole,
              note,
              resolution === 'blocked' ? (note ?? 'Blocked without a stated reason.') : null,
            );

      // A move into a terminal lane already released the claim; releasing again
      // would overwrite the reason with a less specific one.
      const after = await this.requireCard(ctx.tx, ctx.project.id, card.id, false);
      if (!after.claimReleasedAt) {
        await ctx.tx
          .update(coordProjectCards)
          .set({
            claimReleasedAt: ctx.now,
            claimReleaseReason: note ? `Released: ${note}` : 'Released by its holder.',
            updatedAt: ctx.now,
          })
          .where(eq(coordProjectCards.id, card.id));
      }

      await this.emit(
        ctx,
        'release',
        card,
        {
          card_id: card.id,
          card_number: Number(card.cardNumber),
          title: card.title,
          resolution,
          from: current.columnKey,
          to: target.columnKey,
          note,
        },
        'project.card.released',
      );

      const fresh = await this.requireCard(ctx.tx, ctx.project.id, card.id, false);
      return {
        released: true,
        project: ctx.project.slug,
        card: this.cardWire(fresh, ctx.columns, ctx.now, actor, new Map()),
        from_column: { key: current.columnKey, title: current.title },
        to_column: { key: target.columnKey, title: target.title },
        advisories: moved?.advisories ?? [],
      };
    });
  }

  async updateCard(args: Record<string, unknown>, host: Host | null): Promise<Record<string, unknown>> {
    const slug = requiredString(args, 'slug');
    const actor = host ? actorFromHost(host, args, optionalString(args, 'engine')) : OPERATOR_ACTOR;

    return await this.withBoard(slug, actor, async (ctx) => {
      const card = await this.requireCard(ctx.tx, ctx.project.id, args['card'], true);
      const patch: Record<string, unknown> = { updatedAt: ctx.now };
      if (args['title'] !== undefined) {
        patch['title'] = boundedText(requiredString(args, 'title'), MAX_TITLE, 'title');
      }
      if (args['detail'] !== undefined) {
        patch['detail'] = boundedText(optionalString(args, 'detail') ?? '', MAX_DETAIL, 'detail');
      }
      if (args['labels'] !== undefined) patch['labels'] = normalizeLabels(args['labels']);
      if (args['priority'] !== undefined) patch['priority'] = Number(args['priority']) || 0;
      if (args['blocked_reason'] !== undefined) {
        const reason = optionalString(args, 'blocked_reason');
        patch['blockedReason'] = reason ? boundedText(reason, MAX_BLOCKED_REASON, 'blocked_reason') : null;
      }

      await ctx.tx.update(coordProjectCards).set(patch).where(eq(coordProjectCards.id, card.id));
      const fresh = await this.requireCard(ctx.tx, ctx.project.id, card.id, false);
      await this.emit(
        ctx,
        'update',
        card,
        { card_id: card.id, card_number: Number(card.cardNumber), title: fresh.title },
        'project.card.updated',
      );
      return {
        project: ctx.project.slug,
        card: this.cardWire(fresh, ctx.columns, ctx.now, actor, new Map()),
      };
    });
  }

  /** Archive rather than delete, so the card's events keep a row to point at. */
  async archiveCard(args: Record<string, unknown>, host: Host | null): Promise<Record<string, unknown>> {
    const slug = requiredString(args, 'slug');
    const actor = host ? actorFromHost(host, args, optionalString(args, 'engine')) : OPERATOR_ACTOR;
    return await this.withBoard(slug, actor, async (ctx) => {
      const card = await this.requireCard(ctx.tx, ctx.project.id, args['card'], true);
      await ctx.tx
        .update(coordProjectCards)
        .set({
          archivedAt: ctx.now,
          claimReleasedAt: card.claimReleasedAt ?? ctx.now,
          claimReleaseReason: card.claimReleaseReason ?? 'Card archived.',
          updatedAt: ctx.now,
        })
        .where(eq(coordProjectCards.id, card.id));
      await this.emit(
        ctx,
        'delete',
        card,
        { card_id: card.id, card_number: Number(card.cardNumber) },
        'project.card.deleted',
      );
      return { project: ctx.project.slug, deleted: Number(card.cardNumber) };
    });
  }

  private columnByRef(columns: ColumnRow[], ref: string): ColumnRow {
    const needle = ref.trim().toLowerCase();
    const found =
      columns.find((column) => column.id === ref) ??
      columns.find((column) => column.columnKey.toLowerCase() === needle) ??
      columns.find((column) => column.title.toLowerCase() === needle);
    if (!found) {
      throw new ValidationError(
        `No column "${ref}" on this board. Available: ${columns.map((column) => column.columnKey).join(', ')}`,
        { param: 'column' },
      );
    }
    return found;
  }

  // ── the todo compatibility shim ───────────────────────────────────────────

  /**
   * `project_todo_*` did not go away; it became a view of this table.
   *
   * Migration 0026 moved every todo onto a card AND KEPT ITS ID as the card
   * number, so `project_todo_done(4711)` still resolves to the same work item it
   * always did. That is the whole reason the shim can exist without a
   * translation table: the identifier never changed, only what it points at.
   *
   * Todos are deliberately NOT a second store kept in step with this one. One
   * work item is one row; there is nothing to reconcile, and no way for the two
   * views to disagree about whether something is done. What a todo caller loses
   * is expressiveness — it sees `done`, not which of five lanes the card is in —
   * and that is the honest shape of the older API rather than a bug in it.
   */
  private todoWire(card: CoordProjectCard, columns: ColumnRow[]): ProjectTodoWire {
    const column = columns.find((entry) => entry.id === card.columnId) ?? null;
    const done = column?.isTerminal === 1;
    return {
      id: Number(card.cardNumber),
      project_id: card.projectId === null ? 0 : Number(card.projectId),
      title: card.title,
      detail: card.detail,
      done,
      done_at: done ? card.enteredColumnAt : null,
      source_host_id: card.createdByHostId === null ? null : Number(card.createdByHostId),
      created_at: card.createdAt,
      updated_at: card.updatedAt,
    };
  }

  /**
   * The read path for todos, and for `project_detail`'s counts. Deliberately
   * does not sweep or open a transaction: it runs on every project detail, and
   * a listing that reclaims claims would make an innocuous read a write.
   */
  async todoRowsFor(projectId: number): Promise<ProjectTodoWire[]> {
    const boards = await this.deps.db
      .select({ id: coordProjectBoards.id })
      .from(coordProjectBoards)
      .where(
        and(eq(coordProjectBoards.projectId, projectId), eq(coordProjectBoards.slug, DEFAULT_BOARD_SLUG)),
      )
      .limit(1);
    const boardId = boards[0]?.id;
    if (!boardId) return [];
    const [columns, cards] = await Promise.all([
      this.fetchColumns(this.deps.db, boardId),
      this.cardsOf(this.deps.db, projectId),
    ]);
    return cards
      .map((card) => this.todoWire(card, columns))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id);
  }

  async todoCreate(
    slug: string,
    payload: { title: string; detail: string },
    sourceHostId: number | null,
  ): Promise<{ project: string; todo: ProjectTodoWire }> {
    const actor: CardActor = { ...OPERATOR_ACTOR, hostId: sourceHostId };
    return await this.withBoard(slug, actor, async (ctx) => {
      const column = this.intakeColumn(ctx.columns);
      const number = await this.allocateCardNumber(ctx.tx, ctx.boardId, ctx.now);
      const id = randomUUID();
      await ctx.tx.insert(coordProjectCards).values({
        id,
        projectId: ctx.project.id,
        boardId: ctx.boardId,
        columnId: column.id,
        cardNumber: number,
        title: payload.title,
        detail: payload.detail,
        labels: null,
        priority: 0,
        blockedReason: null,
        sourceTodoId: null,
        createdByHostId: actor.hostId,
        enteredColumnAt: ctx.now,
        archivedAt: null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      });
      await this.emit(
        ctx,
        'create',
        { id, cardNumber: number },
        { card_id: id, card_number: number, title: payload.title, column: column.columnKey, via: 'todo' },
        'project.card.created',
      );
      const card = await this.requireCard(ctx.tx, ctx.project.id, id, false);
      return { project: ctx.project.slug, todo: this.todoWire(card, ctx.columns) };
    });
  }

  async todoUpdate(
    slug: string,
    id: number,
    payload: { title: string; detail: string },
    sourceHostId: number | null,
  ): Promise<{ project: string; todo: ProjectTodoWire }> {
    const actor: CardActor = { ...OPERATOR_ACTOR, hostId: sourceHostId };
    return await this.withBoard(slug, actor, async (ctx) => {
      const card = await this.requireCardAsTodo(ctx, id);
      await ctx.tx
        .update(coordProjectCards)
        .set({ title: payload.title, detail: payload.detail, updatedAt: ctx.now })
        .where(eq(coordProjectCards.id, card.id));
      const fresh = await this.requireCard(ctx.tx, ctx.project.id, card.id, false);
      await this.emit(
        ctx,
        'update',
        card,
        { card_id: card.id, card_number: Number(card.cardNumber), title: fresh.title, via: 'todo' },
        'project.card.updated',
      );
      return { project: ctx.project.slug, todo: this.todoWire(fresh, ctx.columns) };
    });
  }

  /**
   * `done` moves the card to the terminal lane. `undone` is a NO-OP on a card
   * that is not there — the old contract is "not finished", which a card sitting
   * in Coding already satisfies, and teleporting it back to Backlog would
   * silently throw away its position in the pipeline. Only a card that really is
   * in the terminal lane moves, and it goes to intake because nothing records
   * where it came from.
   */
  async todoSetDone(
    slug: string,
    id: number,
    done: boolean,
    sourceHostId: number | null,
  ): Promise<{ project: string; todo: ProjectTodoWire }> {
    const actor: CardActor = { ...OPERATOR_ACTOR, hostId: sourceHostId };
    return await this.withBoard(slug, actor, async (ctx) => {
      const card = await this.requireCardAsTodo(ctx, id);
      const current = ctx.columns.find((entry) => entry.id === card.columnId) ?? null;
      const isDone = current?.isTerminal === 1;
      if (done !== isDone) {
        const target = done ? this.pickFlagged(ctx.columns, 'isTerminal') : this.intakeColumn(ctx.columns);
        if (target) await this.applyMove(ctx, card, target, null, null, null);
      }
      const fresh = await this.requireCard(ctx.tx, ctx.project.id, card.id, false);
      return { project: ctx.project.slug, todo: this.todoWire(fresh, ctx.columns) };
    });
  }

  async todoDelete(slug: string, id: number, sourceHostId: number | null): Promise<{ project: string; deleted: number }> {
    const actor: CardActor = { ...OPERATOR_ACTOR, hostId: sourceHostId };
    return await this.withBoard(slug, actor, async (ctx) => {
      const card = await this.requireCardAsTodo(ctx, id);
      await ctx.tx
        .update(coordProjectCards)
        .set({
          archivedAt: ctx.now,
          claimReleasedAt: card.claimReleasedAt ?? ctx.now,
          claimReleaseReason: card.claimReleaseReason ?? 'Card archived.',
          updatedAt: ctx.now,
        })
        .where(eq(coordProjectCards.id, card.id));
      await this.emit(
        ctx,
        'delete',
        card,
        { card_id: card.id, card_number: Number(card.cardNumber), via: 'todo' },
        'project.card.deleted',
      );
      return { project: ctx.project.slug, deleted: id };
    });
  }

  /** `Todo not found` rather than `Card not found`: the caller asked for a todo. */
  private async requireCardAsTodo(ctx: BoardContext, id: number): Promise<CoordProjectCard> {
    try {
      return await this.requireCard(ctx.tx, ctx.project.id, id, true);
    } catch {
      throw new NotFoundError('Todo not found', 'todo_not_found');
    }
  }

  // ── admin surface ─────────────────────────────────────────────────────────

  async adminBoard(slug: string): Promise<Record<string, unknown>> {
    return await this.withBoard(slug, OPERATOR_ACTOR, (ctx) =>
      this.renderBoard(ctx, { column: null, role: null, mine: false, unclaimed: false }),
    );
  }

  /**
   * Take a card back on behalf of the operator. The console is the escape hatch
   * for a claim whose holder is unreachable but not detectably dead — a wedged
   * process, a laptop asleep — which neither signal in `sweepClaims` will catch.
   */
  async adminForceRelease(slug: string, ref: unknown, reason: string | null): Promise<Record<string, unknown>> {
    return await this.withBoard(slug, OPERATOR_ACTOR, async (ctx) => {
      const card = await this.requireCard(ctx.tx, ctx.project.id, ref, true);
      const message = reason?.trim()
        ? `Released by an operator: ${reason.trim()}`
        : 'Released by an operator.';
      await ctx.tx
        .update(coordProjectCards)
        .set({ claimReleasedAt: ctx.now, claimReleaseReason: message, updatedAt: ctx.now })
        .where(eq(coordProjectCards.id, card.id));
      await this.emit(
        ctx,
        'force_release',
        card,
        {
          card_id: card.id,
          card_number: Number(card.cardNumber),
          title: card.title,
          previous_holder: card.claimedByUsername,
          reason: message,
        },
        'project.card.released',
      );
      const fresh = await this.requireCard(ctx.tx, ctx.project.id, card.id, false);
      return {
        released: true,
        project: ctx.project.slug,
        card: this.cardWire(fresh, ctx.columns, ctx.now, OPERATOR_ACTOR, new Map()),
      };
    });
  }

  /**
   * Reshape one lane. Create and delete are deliberately absent: 0026 seeds the
   * seven lanes, and a delete would have to answer what happens to the cards in
   * it — which is a product question, not a plumbing one.
   */
  async adminUpdateColumn(
    slug: string,
    columnId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.withBoard(slug, OPERATOR_ACTOR, async (ctx) => {
      const column = ctx.columns.find((entry) => entry.id === columnId);
      if (!column) throw new NotFoundError('Column not found');
      const update: Record<string, unknown> = { updatedAt: ctx.now };
      if (patch['title'] !== undefined) {
        update['title'] = boundedText(String(patch['title']).trim(), MAX_TITLE, 'title');
      }
      if (patch['wip_limit'] !== undefined) {
        const raw = patch['wip_limit'];
        update['wipLimit'] = raw === null || raw === '' ? null : Math.max(0, Number(raw) || 0) || null;
      }
      if (patch['allowed_roles'] !== undefined) {
        const raw = patch['allowed_roles'];
        if (raw === null) update['allowedRoles'] = null;
        else {
          if (!Array.isArray(raw)) {
            throw new ValidationError('allowed_roles must be an array or null', { param: 'allowed_roles' });
          }
          const roles = raw.map((entry) => normalizeProjectBoardRole(entry));
          if (roles.some((role) => role === null)) {
            throw new ValidationError(
              `allowed_roles may only contain: ${PROJECT_BOARD_ROLES.join(', ')}`,
              { param: 'allowed_roles' },
            );
          }
          update['allowedRoles'] = roles.length > 0 ? roles : null;
        }
      }
      if (patch['position'] !== undefined) update['position'] = Math.max(0, Number(patch['position']) || 0);
      if (patch['default_next_column_id'] !== undefined) {
        const raw = patch['default_next_column_id'];
        if (raw === null || raw === '') update['defaultNextColumnId'] = null;
        else {
          const next = ctx.columns.find((entry) => entry.id === String(raw));
          if (!next) {
            throw new ValidationError('default_next_column_id must name a column on this board', {
              param: 'default_next_column_id',
            });
          }
          if (next.id === column.id) {
            throw new ValidationError('a column cannot advance to itself', {
              param: 'default_next_column_id',
            });
          }
          update['defaultNextColumnId'] = next.id;
        }
      }

      await ctx.tx
        .update(coordProjectBoardColumns)
        .set(update)
        .where(eq(coordProjectBoardColumns.id, column.id));
      ctx.publishes.push({
        event: 'project.board.updated',
        payload: { slug: ctx.project.slug, column_id: column.id },
      });
      const columns = await this.fetchColumns(ctx.tx, ctx.boardId);
      const fresh = columns.find((entry) => entry.id === column.id)!;
      return { project: ctx.project.slug, column: this.columnWire(fresh) };
    });
  }
}
