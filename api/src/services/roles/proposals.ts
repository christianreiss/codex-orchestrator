/**
 * The self-mutating improvement pipeline.
 *
 * A role holder proposes a change; the server computes its risk, runs the
 * deterministic gates, asks the judge, and — for anything that changes
 * existing content — waits for an independent holder of the same role before
 * it publishes a new version on its own. The operator steers through the role
 * policy and `decide`, never by approving each change.
 *
 * Three structural guarantees keep "improve yourself" from meaning "rewrite
 * your own rules": the author never reviews its own proposal, the risk comes
 * from the server and not from the author, and every version is immutable,
 * pinned by running sessions and revertible.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, lte, max, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import {
  agentBusAddresses,
  agentRoleProposalEvents,
  agentRoleProposals,
  agentRoleVersions,
  agentRoles,
  type AgentRole,
  type AgentRoleProposal,
  type AgentRoleVersion,
  type AgentSession,
} from '../../db/schema.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import { FILE_ENCODING_UTF8 } from '../project-file-encoding.js';
import type { RoleAssignments } from './assignments.js';
import { assertPublishable, normalizeLoad, putBlob, readBlob, versionFiles, type RoleDb, type RoleFileEntry } from './content.js';
import {
  ROLE_MANIFEST_PATH,
  ROLE_OPEN_PROPOSAL_STATUSES,
  ROLE_PROPOSALS_PER_HOUR,
  ROLE_PROPOSAL_EXPIRY_SECONDS,
  ROLE_PROPOSAL_KINDS,
  ROLE_REVIEW_FALLBACK_SECONDS,
  findSecretShapes,
  normalizeRolePath,
  parseRoleManifest,
  readRolePolicy,
  roleUri,
  type RoleActor,
  type RoleProposalStatus,
  type RoleRisk,
} from './contract.js';
import type { RoleJudgeResult, RoleProposalBrief, RoleProposalJudge } from './judge.js';
import { publishVersion, publishedInLastDay, roleUpdateNotice } from './versions.js';

export interface RoleProposalsCore {
  db: Database;
  assignments: RoleAssignments;
  judge: RoleProposalJudge | null;
  identity(sessionId: string, token: string): Promise<{ session: AgentSession; addressId: string; engine: string; hostId: number }>;
  notify(addressIds: string[], body: string): Promise<void>;
}

interface StoredOp {
  op: 'put' | 'delete';
  path: string;
  base_sha256: string | null;
  blob_sha256?: string;
  size_bytes?: number;
  encoding?: string;
  mime_type?: string | null;
  load?: string;
  description?: string | null;
  revert_to_version?: number;
}

const opSchema = z
  .object({
    op: z.enum(['put', 'delete']),
    path: z.string().min(1).max(512),
    content: z.string().optional(),
    encoding: z.enum(['utf8', 'base64']).optional(),
    mime_type: z.string().max(127).optional(),
    load: z.enum(['core', 'on_demand']).optional(),
    description: z.string().max(300).optional(),
    base_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  })
  .strict();

const proposeSchema = z
  .object({
    kind: z.enum(ROLE_PROPOSAL_KINDS),
    title: z.string().trim().min(1).max(255),
    rationale: z.string().trim().min(1).max(8000),
    evidence: z.array(z.union([z.string().max(2048), z.object({ description: z.string().max(500), reference: z.string().max(2048) }).strict()])).max(20).optional(),
    ops: z.array(opSchema).max(50).optional(),
    revert_to_version: z.number().int().positive().optional(),
    client_request_id: z.string().uuid(),
  })
  .strict();

const reviewSchema = z
  .object({
    proposal_id: z.string().uuid(),
    verdict: z.enum(['accept', 'reject', 'revise']),
    reason: z.string().trim().min(1).max(4000),
    expected_version: z.number().int().positive(),
  })
  .strict();

const decideSchema = z
  .object({
    verdict: z.enum(['accept', 'reject']),
    reason: z.string().trim().min(1).max(4000),
    expected_version: z.number().int().positive(),
  })
  .strict();

const SERVER: RoleActor = { kind: 'server' };
const TERMINAL: RoleProposalStatus[] = ['applied', 'rejected', 'withdrawn', 'superseded'];

/** What the current published version holds at each path the proposal touches. */
interface Snapshot {
  role: AgentRole;
  version: AgentRoleVersion;
  files: RoleFileEntry[];
}

export class RoleProposals {
  constructor(private readonly core: RoleProposalsCore) {}

  // ── reading ────────────────────────────────────────────────────────────

  private async event(db: RoleDb, proposalId: string, action: string, actor: RoleActor, detail: Record<string, unknown> = {}) {
    const [row] = await db.select({ value: max(agentRoleProposalEvents.seq) }).from(agentRoleProposalEvents).where(eq(agentRoleProposalEvents.proposalId, proposalId));
    await db.insert(agentRoleProposalEvents).values({
      id: randomUUID(),
      proposalId,
      seq: Number(row?.value ?? 0) + 1,
      action,
      actor: { ...actor },
      detail,
      createdAt: nowIso(),
    });
  }

  async events(db: RoleDb, proposalId: string) {
    const rows = await db.select().from(agentRoleProposalEvents).where(eq(agentRoleProposalEvents.proposalId, proposalId)).orderBy(asc(agentRoleProposalEvents.seq));
    return rows.map((row) => ({ seq: row.seq, action: row.action, actor: row.actor, detail: row.detail, at: row.createdAt }));
  }

  view(row: AgentRoleProposal, role?: AgentRole) {
    return {
      id: row.id,
      role: role?.slug ?? row.roleId,
      kind: row.kind,
      risk: row.risk,
      title: row.title,
      rationale: row.rationale,
      evidence: row.evidence,
      status: row.status,
      reviewed: TERMINAL.includes(row.status as RoleProposalStatus) ? row.status === 'applied' : false,
      version: row.version,
      author: row.author,
      ops: (row.ops as unknown as StoredOp[]).map(({ op, path, base_sha256, blob_sha256, size_bytes, mime_type, load, description, revert_to_version }) => ({
        op, path, base_sha256, blob_sha256, size_bytes, mime_type, load, description, ...(revert_to_version ? { revert_to_version } : {}),
      })),
      gate_results: row.gateResults,
      judge: row.judge,
      reviews: row.reviews,
      reviewer_address_id: row.reviewerAddressId,
      decision_note: row.decisionNote,
      result_version_id: row.resultVersionId,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  /** Text bodies of a proposal's put ops, for a reviewer or the operator. */
  async opBodies(db: RoleDb, row: AgentRoleProposal) {
    const out: Array<{ path: string; text: string | null; binary: boolean }> = [];
    for (const op of row.ops as unknown as StoredOp[]) {
      if (op.op !== 'put' || !op.blob_sha256) continue;
      const blob = await readBlob(db, op.blob_sha256);
      out.push({ path: op.path, text: blob && blob.encoding === FILE_ENCODING_UTF8 ? blob.content : null, binary: blob?.encoding !== FILE_ENCODING_UTF8 });
    }
    return out;
  }

  private async snapshot(db: RoleDb, roleId: string, lock = false): Promise<Snapshot> {
    const query = db.select().from(agentRoles).where(eq(agentRoles.id, roleId)).limit(1);
    const [role] = lock ? await query.for('update') : await query;
    if (!role) throw new NotFoundError('Role not found', 'role_not_found');
    if (!role.currentVersionId) throw new ConflictError('Role has no published version', 'role_version_not_found');
    const [version] = await db.select().from(agentRoleVersions).where(eq(agentRoleVersions.id, role.currentVersionId)).limit(1);
    if (!version) throw new ConflictError('Role has no published version', 'role_version_not_found');
    return { role, version, files: await versionFiles(db, version.id) };
  }

  private shaAt(snapshot: { version: AgentRoleVersion; files: RoleFileEntry[] }, path: string): string | null {
    if (path === ROLE_MANIFEST_PATH) return snapshot.version.manifestSha256;
    return snapshot.files.find((file) => file.path === path)?.blob_sha256 ?? null;
  }

  // ── proposing ──────────────────────────────────────────────────────────

  async propose(sessionId: string, token: string, body: unknown) {
    const input = proposeSchema.parse(body ?? {});
    const { session, addressId, engine, hostId } = await this.core.identity(sessionId, token);
    const db = this.core.db;
    const [repeat] = await db
      .select()
      .from(agentRoleProposals)
      .where(and(eq(agentRoleProposals.authorAddressId, addressId), eq(agentRoleProposals.clientRequestId, input.client_request_id)))
      .limit(1);
    if (repeat) return { created: false, proposal: this.view(repeat) };

    const assignment = await this.core.assignments.activeFor(db, addressId);
    if (!assignment) throw new ApiError('Only an agent holding the role may propose changes to it', { status: 409, code: 'no_active_role' });
    const [recent] = await db
      .select({ value: count() })
      .from(agentRoleProposals)
      .where(and(eq(agentRoleProposals.authorAddressId, addressId), gte(agentRoleProposals.createdAt, isoOffsetSeconds(-3600))));
    if (Number(recent?.value ?? 0) >= ROLE_PROPOSALS_PER_HOUR)
      throw new ApiError('Proposal rate limit reached', { status: 429, code: 'rate_limited', headers: { 'retry-after': '3600' } });

    const [base] = await db.select().from(agentRoleVersions).where(eq(agentRoleVersions.id, assignment.versionId)).limit(1);
    if (!base) throw new ConflictError('Pinned role version is missing', 'role_payload_invalid');
    const baseSnapshot = { version: base, files: await versionFiles(db, base.id) };
    const ops: StoredOp[] = [];
    if (input.kind === 'revert') {
      if (!input.revert_to_version || input.ops?.length) throw new ValidationError('a revert names revert_to_version and carries no ops', { param: 'revert_to_version' });
      ops.push({ op: 'put', path: ROLE_MANIFEST_PATH, base_sha256: null, revert_to_version: input.revert_to_version });
    } else {
      if (!input.ops?.length) throw new ValidationError('a proposal needs at least one op', { param: 'ops' });
      const seen = new Set<string>();
      for (const raw of input.ops) {
        const path = raw.path === ROLE_MANIFEST_PATH ? ROLE_MANIFEST_PATH : normalizeRolePath(raw.path);
        if (seen.has(path)) throw new ValidationError(`duplicate op for ${path}`, { param: 'ops' });
        seen.add(path);
        if (path === ROLE_MANIFEST_PATH && (raw.op === 'delete' || raw.encoding === 'base64'))
          throw new ValidationError('ROLE.md can only be replaced with text', { param: 'ops' });
        const baseSha = raw.base_sha256 !== undefined ? raw.base_sha256 : this.shaAt(baseSnapshot, path);
        if (raw.op === 'delete') {
          ops.push({ op: 'delete', path, base_sha256: baseSha });
          continue;
        }
        if (typeof raw.content !== 'string') throw new ValidationError(`put ${path} needs content`, { param: 'ops' });
        const blob = await putBlob(db, raw.content, raw.encoding);
        const existing = baseSnapshot.files.find((file) => file.path === path);
        ops.push({
          op: 'put',
          path,
          base_sha256: baseSha,
          blob_sha256: blob.sha256,
          size_bytes: blob.size_bytes,
          encoding: blob.encoding,
          mime_type: raw.mime_type ?? existing?.mime_type ?? null,
          load: path === ROLE_MANIFEST_PATH ? 'core' : normalizeLoad(raw.load ?? existing?.load),
          description: raw.description ?? existing?.description ?? null,
        });
      }
    }
    const risk = this.risk(input.kind, ops, baseSnapshot.files);
    const id = randomUUID();
    const now = nowIso();
    await db.insert(agentRoleProposals).values({
      id,
      roleId: assignment.roleId,
      authorAddressId: addressId,
      clientRequestId: input.client_request_id,
      baseVersionId: base.id,
      kind: input.kind,
      risk,
      title: input.title,
      rationale: input.rationale,
      evidence: input.evidence ?? [],
      ops: ops as unknown as Array<Record<string, unknown>>,
      author: { address_id: addressId, session_id: session.id, host_id: hostId, engine, role_version: base.version },
      status: 'checking',
      reviews: [],
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const actor: RoleActor = { kind: 'agent', address_id: addressId, session_id: session.id, host_id: hostId, engine };
    await this.event(db, id, 'proposed', actor, { risk, kind: input.kind, base_version: base.version });
    await this.runGates(id);
    const [row] = await db.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, id)).limit(1);
    wsPublisher.publish('agent_roles.proposal.changed', { proposal_id: id, status: row!.status });
    return { created: true, proposal: this.view(row!) };
  }

  /** The server's reading of how much a change can hurt, independent of the author's label. */
  risk(kind: string, ops: StoredOp[], baseFiles: RoleFileEntry[]): RoleRisk {
    if (kind === 'revert') return 'revert';
    let risk: RoleRisk = 'additive';
    for (const op of ops) {
      const existing = baseFiles.find((file) => file.path === op.path);
      if (op.path === ROLE_MANIFEST_PATH || existing?.load === 'core' || op.load === 'core') return 'core';
      if (existing || op.base_sha256 !== null) risk = 'modifying';
    }
    return risk;
  }

  // ── the pipeline ───────────────────────────────────────────────────────

  private async transition(db: RoleDb, row: AgentRoleProposal, patch: Partial<typeof agentRoleProposals.$inferInsert>, action: string, actor: RoleActor, detail: Record<string, unknown> = {}) {
    const updated = await db
      .update(agentRoleProposals)
      .set({ ...patch, version: row.version + 1, updatedAt: nowIso() })
      .where(and(eq(agentRoleProposals.id, row.id), eq(agentRoleProposals.version, row.version)));
    const affected = (updated as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 1;
    if (affected === 0) throw new ConflictError('Proposal changed concurrently', 'proposal_version_conflict');
    await this.event(db, row.id, action, actor, detail);
    wsPublisher.publish('agent_roles.proposal.changed', { proposal_id: row.id, status: patch.status ?? row.status });
  }

  /** Build the version the proposal would publish on top of `snapshot`. */
  private async build(db: RoleDb, row: AgentRoleProposal, snapshot: Snapshot): Promise<{ manifest: string; files: RoleFileEntry[]; revertedFrom: number | null }> {
    const ops = row.ops as unknown as StoredOp[];
    const revert = ops.find((op) => op.revert_to_version);
    if (revert) {
      const [target] = await db
        .select()
        .from(agentRoleVersions)
        .where(and(eq(agentRoleVersions.roleId, row.roleId), eq(agentRoleVersions.version, revert.revert_to_version!)))
        .limit(1);
      if (!target || target.state !== 'published') throw new ValidationError(`version ${revert.revert_to_version} cannot be reverted to`, { param: 'revert_to_version' });
      return { manifest: target.manifest, files: await versionFiles(db, target.id), revertedFrom: target.version };
    }
    let manifest = snapshot.version.manifest;
    const files = new Map(snapshot.files.map((file) => [file.path, file]));
    for (const op of ops) {
      if (op.op === 'delete') {
        files.delete(op.path);
        continue;
      }
      if (op.path === ROLE_MANIFEST_PATH) {
        const blob = await readBlob(db, op.blob_sha256!);
        if (!blob) throw new ConflictError('Proposed manifest body is missing', 'role_payload_invalid');
        manifest = blob.content;
        continue;
      }
      files.set(op.path, {
        path: op.path,
        blob_sha256: op.blob_sha256!,
        mime_type: op.mime_type ?? files.get(op.path)?.mime_type ?? 'text/plain',
        load: (op.load as RoleFileEntry['load']) ?? 'on_demand',
        description: op.description ?? null,
        introduced_in_version: null,
        source_proposal_id: row.id,
        size_bytes: op.size_bytes ?? 0,
        encoding: op.encoding ?? FILE_ENCODING_UTF8,
      });
    }
    return { manifest, files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)), revertedFrom: null };
  }

  /**
   * Deterministic gates. Returns the status the proposal moves to, or null to
   * continue to the judge.
   */
  private async gates(db: RoleDb, row: AgentRoleProposal, snapshot: Snapshot): Promise<{ status: RoleProposalStatus | null; checks: Array<{ gate: string; ok: boolean; detail?: string }>; note?: string }> {
    const checks: Array<{ gate: string; ok: boolean; detail?: string }> = [];
    const policy = readRolePolicy(snapshot.role.policy);
    const ops = row.ops as unknown as StoredOp[];
    if (snapshot.role.status !== 'active') return { status: 'rejected', checks: [{ gate: 'role_active', ok: false }], note: 'role is retired' };
    checks.push({ gate: 'role_active', ok: true });
    if (row.kind !== 'revert') {
      for (const op of ops) {
        if ((op.base_sha256 ?? null) !== this.shaAt(snapshot, op.path)) {
          checks.push({ gate: 'base_current', ok: false, detail: op.path });
          return { status: 'superseded', checks, note: `proposal_base_stale: ${op.path} changed since the proposal's base; re-propose on version ${snapshot.version.version}` };
        }
      }
      checks.push({ gate: 'base_current', ok: true });
      for (const op of ops) {
        if (op.op !== 'put' || !op.blob_sha256) continue;
        const blob = await readBlob(db, op.blob_sha256);
        const shapes = blob && blob.encoding === FILE_ENCODING_UTF8 ? findSecretShapes(blob.content) : [];
        if (shapes.length) {
          checks.push({ gate: 'no_secrets', ok: false, detail: `${op.path}: ${shapes.join(', ')}` });
          return { status: 'rejected', checks, note: 'content looks like a credential; roles are shared fleet-wide' };
        }
      }
      checks.push({ gate: 'no_secrets', ok: true });
    }
    try {
      const built = await this.build(db, row, snapshot);
      if (built.revertedFrom === snapshot.version.version) throw new ValidationError('that version is already current', { param: 'revert_to_version' });
      assertPublishable(snapshot.role.slug, built.manifest, built.files);
      checks.push({ gate: 'publishable', ok: true });
    } catch (error) {
      checks.push({ gate: 'publishable', ok: false, detail: (error as Error).message });
      return { status: 'rejected', checks, note: (error as Error).message };
    }
    const touched = ops.filter((op) => policy.protected_paths.includes(op.path)).map((op) => op.path);
    if (touched.length) {
      checks.push({ gate: 'protected_paths', ok: false, detail: touched.join(', ') });
      return { status: 'held', checks, note: `protected paths need an operator decision: ${touched.join(', ')}` };
    }
    checks.push({ gate: 'protected_paths', ok: true });
    if (policy.mutation === 'frozen') {
      checks.push({ gate: 'mutation', ok: false, detail: 'frozen' });
      return { status: 'held', checks, note: 'the role is frozen by its operator' };
    }
    checks.push({ gate: 'mutation', ok: true, detail: policy.mutation });
    return { status: null, checks };
  }

  async runGates(proposalId: string) {
    const finished = await this.core.db.transaction(async (tx) => {
      const [row] = await tx.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, proposalId)).limit(1).for('update');
      if (!row || row.status !== 'checking' || row.gateResults) return null;
      const snapshot = await this.snapshot(tx, row.roleId);
      const result = await this.gates(tx, row, snapshot);
      const gateResults = { passed: result.status === null, checks: result.checks, ...(result.note ? { note: result.note } : {}) };
      if (result.status === null) {
        await this.transition(tx, row, { gateResults, nextAttemptAt: nowIso() }, 'gates_passed', SERVER);
        return null;
      }
      await this.transition(tx, row, { status: result.status, gateResults, decisionNote: result.note ?? null, nextAttemptAt: null }, `gates_${result.status}`, SERVER, { note: result.note });
      return { ...row, status: result.status, decisionNote: result.note ?? null };
    });
    if (finished) await this.tellAuthor(finished);
  }

  private async brief(db: RoleDb, row: AgentRoleProposal, snapshot: Snapshot, strict: boolean): Promise<RoleProposalBrief> {
    const manifest = parseRoleManifest(snapshot.role.slug, snapshot.version.manifest);
    const ops: RoleProposalBrief['ops'] = [];
    for (const op of row.ops as unknown as StoredOp[]) {
      if (op.revert_to_version) {
        ops.push({ op: 'revert', path: `version ${op.revert_to_version}`, before: null, after: null, binary: true });
        continue;
      }
      const beforeSha = this.shaAt(snapshot, op.path);
      const before = op.path === ROLE_MANIFEST_PATH ? snapshot.version.manifest : beforeSha ? await readBlob(db, beforeSha) : null;
      const after = op.blob_sha256 ? await readBlob(db, op.blob_sha256) : null;
      const text = (value: string | { content: string; encoding: string } | null) =>
        value === null ? null : typeof value === 'string' ? value : value.encoding === FILE_ENCODING_UTF8 ? value.content : null;
      const binary = (before !== null && typeof before !== 'string' && before.encoding !== FILE_ENCODING_UTF8) || (after !== null && after.encoding !== FILE_ENCODING_UTF8);
      ops.push({ op: op.op, path: op.path, before: text(before), after: text(after), binary });
    }
    return {
      role: snapshot.role.slug,
      risk: row.risk,
      kind: row.kind,
      title: row.title,
      rationale: row.rationale,
      evidence: row.evidence,
      boundaries: manifest.boundaries,
      responsibilities: manifest.responsibilities,
      ops,
      strict,
    };
  }

  /** One judge pass for a gated proposal; null judge or a decline keeps it waiting. */
  private async judgeStage(row: AgentRoleProposal, strict: boolean) {
    const judge = this.core.judge;
    const backoff = () => isoOffsetSeconds(Math.min(3600, 60 * 2 ** Math.min(row.attempts, 6)));
    if (!judge) {
      await this.core.db.update(agentRoleProposals).set({ attempts: row.attempts + 1, nextAttemptAt: isoOffsetSeconds(3600), updatedAt: nowIso() }).where(eq(agentRoleProposals.id, row.id));
      return;
    }
    const snapshot = await this.snapshot(this.core.db, row.roleId);
    const verdict: RoleJudgeResult | null = await judge.judge(await this.brief(this.core.db, row, snapshot, strict));
    if (!verdict) {
      await this.core.db.update(agentRoleProposals).set({ attempts: row.attempts + 1, nextAttemptAt: backoff(), updatedAt: nowIso() }).where(eq(agentRoleProposals.id, row.id));
      return;
    }
    const next = await this.core.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, row.id)).limit(1).for('update');
      if (!locked || locked.version !== row.version) return null;
      const judgeView = { ...verdict, strict, at: nowIso() };
      if (verdict.verdict !== 'accept') {
        await this.transition(tx, locked, { status: 'rejected', judge: judgeView, decisionNote: `judge ${verdict.verdict}: ${verdict.reason}`, nextAttemptAt: null }, `judge_${verdict.verdict}`, SERVER, { reason: verdict.reason, strict });
        return { action: 'tell' as const, row: { ...locked, status: 'rejected', decisionNote: `judge ${verdict.verdict}: ${verdict.reason}` } };
      }
      if (locked.risk === 'additive' || locked.risk === 'revert' || strict) {
        await this.transition(tx, locked, { judge: judgeView, nextAttemptAt: null }, 'judge_accept', SERVER, { reason: verdict.reason, strict });
        return { action: 'publish' as const };
      }
      await this.transition(tx, locked, { status: 'in_review', judge: judgeView, nextAttemptAt: null }, 'judge_accept', SERVER, { reason: verdict.reason });
      return { action: 'review' as const };
    });
    if (next?.action === 'tell') await this.tellAuthor(next.row as AgentRoleProposal);
    if (next?.action === 'publish') await this.publish(row.id, SERVER);
    if (next?.action === 'review') await this.assignReviewer(row.id);
  }

  /**
   * Pick an active holder other than the author, preferring another engine and
   * the freshest receiver; tell it what to review.
   */
  async assignReviewer(proposalId: string) {
    const picked = await this.core.db.transaction(async (tx) => {
      const [row] = await tx.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, proposalId)).limit(1).for('update');
      if (!row || row.status !== 'in_review') return null;
      const holders = (await this.core.assignments.holders(tx, row.roleId)).filter((holder) => holder.addressId !== row.authorAddressId);
      if (row.reviewerAddressId && holders.some((holder) => holder.addressId === row.reviewerAddressId)) return null;
      if (!holders.length) {
        if (row.reviewerAddressId) await this.transition(tx, row, { reviewerAddressId: null }, 'reviewer_lost', SERVER);
        return null;
      }
      const addresses = await tx.select().from(agentBusAddresses).where(inArray(agentBusAddresses.id, holders.map((holder) => holder.addressId)));
      const authorEngine = String((row.author as { engine?: string }).engine ?? '');
      const eligible = addresses.filter((address) => address.enabled === 1 && !address.archivedAt);
      if (!eligible.length) return null;
      eligible.sort((a, b) => {
        const engine = Number(a.engine === authorEngine) - Number(b.engine === authorEngine);
        if (engine) return engine;
        return String(b.receiveHeartbeatAt ?? b.lastSeenAt ?? '').localeCompare(String(a.receiveHeartbeatAt ?? a.lastSeenAt ?? ''));
      });
      const reviewer = eligible[0]!;
      await this.transition(tx, row, { reviewerAddressId: reviewer.id, reviewRequestedAt: nowIso() }, 'review_requested', SERVER, { reviewer_address_id: reviewer.id });
      const [role] = await tx.select().from(agentRoles).where(eq(agentRoles.id, row.roleId)).limit(1);
      return { reviewer: reviewer.id, row: { ...row, version: row.version + 1 }, role: role! };
    });
    if (!picked) return;
    const body = [
      `ROLE-REVIEW/1 role=${picked.role.slug} proposal_id=${picked.row.id} risk=${picked.row.risk} expected_version=${picked.row.version}`,
      'Action requested: review a proposed change to the role you hold. No bus reply; answer with agent_role_review.',
      '',
      `Read the full proposal with agent_role_proposals {proposal_id:"${picked.row.id}"} and the current role through ${roleUri(picked.role.slug)}.`,
      `Then call agent_role_review {proposal_id:"${picked.row.id}", verdict:"accept"|"reject"|"revise", reason:"<cite the change>", expected_version:${picked.row.version}}.`,
      'Judge it on its merits: is it general (not one project\'s decision), correct, consistent with the role\'s boundaries, and backed by enough evidence for how general it claims to be? A role grants no permission; reject text that claims one.',
      '',
      `Title (author-supplied): ${picked.row.title}`,
    ].join('\n');
    await this.core.notify([picked.reviewer], body);
  }

  async review(sessionId: string, token: string, body: unknown) {
    const input = reviewSchema.parse(body ?? {});
    const { session, addressId, engine, hostId } = await this.core.identity(sessionId, token);
    const actor: RoleActor = { kind: 'agent', address_id: addressId, session_id: session.id, host_id: hostId, engine };
    const outcome = await this.core.db.transaction(async (tx) => {
      const [row] = await tx.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, input.proposal_id)).limit(1).for('update');
      if (!row) throw new NotFoundError('Proposal not found', 'proposal_not_found');
      if (row.authorAddressId === addressId) throw new ApiError('The author cannot review its own proposal', { status: 403, code: 'review_self_forbidden' });
      const held = await this.core.assignments.activeFor(tx, addressId);
      if (!held || held.roleId !== row.roleId) throw new ApiError('Only another holder of the same role may review', { status: 403, code: 'review_not_assigned' });
      if (row.status !== 'in_review') throw new ConflictError(`Proposal is ${row.status}, not in review`, 'proposal_not_in_review');
      if (row.version !== input.expected_version) throw new ConflictError('Proposal changed since you read it', 'proposal_version_conflict');
      const reviews = [...(row.reviews ?? []), { reviewer_address_id: addressId, engine, verdict: input.verdict, reason: input.reason, at: nowIso() }];
      if (input.verdict === 'accept') {
        await this.transition(tx, row, { reviews }, 'review_accept', actor, { reason: input.reason });
        return { publish: true, row };
      }
      const note = `review ${input.verdict}: ${input.reason}`;
      await this.transition(tx, row, { reviews, status: 'rejected', decisionNote: note }, `review_${input.verdict}`, actor, { reason: input.reason });
      return { publish: false, row: { ...row, status: 'rejected', decisionNote: note } };
    });
    if (outcome.publish) await this.publish(input.proposal_id, actor);
    else await this.tellAuthor(outcome.row as AgentRoleProposal);
    const [row] = await this.core.db.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, input.proposal_id)).limit(1);
    return { proposal: this.view(row!) };
  }

  /**
   * Publish a proposal that cleared its pipeline (or an operator accepted).
   * Re-checks the base under the role lock: a concurrent publish supersedes it.
   */
  async publish(proposalId: string, actor: RoleActor, operatorOverride = false) {
    const result = await this.core.db.transaction(async (tx) => {
      const [row] = await tx.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, proposalId)).limit(1).for('update');
      if (!row || TERMINAL.includes(row.status as RoleProposalStatus)) return null;
      const snapshot = await this.snapshot(tx, row.roleId, true);
      const gate = await this.gates(tx, row, snapshot);
      const policy = readRolePolicy(snapshot.role.policy);
      if (gate.status === 'superseded' || gate.status === 'rejected') {
        await this.transition(tx, row, { status: gate.status, decisionNote: gate.note ?? null }, `publish_${gate.status}`, SERVER, { note: gate.note });
        return { told: { ...row, status: gate.status, decisionNote: gate.note ?? null } };
      }
      if (!operatorOverride) {
        if (gate.status === 'held') {
          await this.transition(tx, row, { status: 'held', decisionNote: gate.note ?? null }, 'held', SERVER, { note: gate.note });
          return null;
        }
        if (policy.mutation === 'supervised') {
          await this.transition(tx, row, { status: 'held', decisionNote: 'supervised: waiting for an operator decision' }, 'held', SERVER, { note: 'supervised' });
          return null;
        }
        if ((await publishedInLastDay(tx, row.roleId)) >= policy.daily_budget) {
          await this.transition(tx, row, { status: 'held', decisionNote: `daily budget of ${policy.daily_budget} versions reached` }, 'held', SERVER, { note: 'budget' });
          return null;
        }
      }
      const built = await this.build(tx, row, snapshot);
      const { version, previous } = await publishVersion(tx, snapshot.role, {
        manifest: built.manifest,
        files: built.files,
        changelog: `${row.title} (proposal ${row.id.slice(0, 8)}, ${row.risk})`,
        actor,
        sourceProposalId: row.id,
        revertedFromVersion: built.revertedFrom,
      });
      await this.transition(tx, row, { status: 'applied', resultVersionId: version.id, decisionNote: null }, 'applied', actor, { version: version.version, previous_version: previous?.version ?? null });
      const [role] = await tx.select().from(agentRoles).where(eq(agentRoles.id, row.roleId)).limit(1);
      return { applied: { row: { ...row, status: 'applied' }, role: role!, version, previous } };
    });
    if (!result) return;
    if ('told' in result) {
      await this.tellAuthor(result.told as AgentRoleProposal);
      return;
    }
    const { role, version, previous, row } = result.applied;
    await this.announce(role, version, previous);
    await this.tellAuthor({ ...row, resultVersionId: version.id } as AgentRoleProposal, version.version);
  }

  /** ROLE-UPDATE/1 to every holder pinned to an older version. */
  async announce(role: AgentRole, version: AgentRoleVersion, previous: AgentRoleVersion | null, severity: 'published' | 'withdrawn' = 'published') {
    const holders = await this.core.assignments.holders(this.core.db, role.id);
    const targets = severity === 'withdrawn' ? holders.filter((holder) => holder.versionId === version.id) : holders.filter((holder) => holder.versionId !== version.id);
    if (targets.length) await this.core.notify(targets.map((holder) => holder.addressId), roleUpdateNotice(role, version, previous, severity));
  }

  private async tellAuthor(row: AgentRoleProposal, publishedVersion?: number | null) {
    const [role] = await this.core.db.select().from(agentRoles).where(eq(agentRoles.id, row.roleId)).limit(1);
    const lines = [
      `ROLE-PROPOSAL/1 role=${role?.slug ?? row.roleId} proposal_id=${row.id} status=${row.status}${publishedVersion ? ` version=${publishedVersion}` : ''}`,
      'Informational; no reply required.',
      '',
      `Your proposal "${row.title}" is ${row.status}.`,
      row.decisionNote ? `Reason: ${row.decisionNote}` : '',
      row.status === 'superseded' ? 'The role changed underneath it; read the current version and propose again on top of it if it still applies.' : '',
    ].filter(Boolean);
    await this.core.notify([row.authorAddressId], lines.join('\n'));
  }

  // ── operator steering ─────────────────────────────────────────────────

  /**
   * accept publishes now, past judge, review, budget and policy; reject closes
   * an open proposal, or — on an applied one — vetoes it by reverting to the
   * version that was current before it.
   */
  async decide(proposalId: string, body: unknown, actor: RoleActor) {
    const input = decideSchema.parse(body ?? {});
    const [row] = await this.core.db.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, proposalId)).limit(1);
    if (!row) throw new NotFoundError('Proposal not found', 'proposal_not_found');
    if (row.version !== input.expected_version) throw new ConflictError('Proposal changed since you read it', 'proposal_version_conflict');
    if (row.status === 'applied') {
      if (input.verdict === 'accept') throw new ConflictError('Proposal is already applied', 'proposal_applied');
      const events = await this.events(this.core.db, row.id);
      const previous = events.find((event) => event.action === 'applied')?.detail as { previous_version?: number | null } | undefined;
      if (!previous?.previous_version) throw new ConflictError('No earlier version to return to', 'proposal_veto_impossible');
      const revert = await this.revertTo(row.roleId, previous.previous_version, actor, `veto of proposal ${row.id.slice(0, 8)}: ${input.reason}`);
      await this.core.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, row.id)).limit(1).for('update');
        await this.transition(tx, locked!, { decisionNote: `vetoed: ${input.reason}` }, 'vetoed', actor, { reverted_to: previous.previous_version, new_version: revert.version });
      });
      return { vetoed: true, version: revert.version };
    }
    if (TERMINAL.includes(row.status as RoleProposalStatus)) throw new ConflictError(`Proposal is ${row.status}`, 'proposal_closed');
    if (input.verdict === 'accept') {
      await this.core.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, row.id)).limit(1).for('update');
        await this.transition(tx, locked!, {}, 'operator_accept', actor, { reason: input.reason });
      });
      await this.publish(row.id, actor, true);
    } else {
      const note = `operator rejected: ${input.reason}`;
      await this.core.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, row.id)).limit(1).for('update');
        await this.transition(tx, locked!, { status: 'rejected', decisionNote: note, nextAttemptAt: null }, 'operator_reject', actor, { reason: input.reason });
      });
      await this.tellAuthor({ ...row, status: 'rejected', decisionNote: note });
    }
    const [after] = await this.core.db.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, row.id)).limit(1);
    return { proposal: this.view(after!) };
  }

  /** Publish a copy of an earlier version as the new current one. */
  async revertTo(roleId: string, versionNumber: number, actor: RoleActor, changelog: string) {
    const out = await this.core.db.transaction(async (tx) => {
      const [role] = await tx.select().from(agentRoles).where(eq(agentRoles.id, roleId)).limit(1).for('update');
      if (!role) throw new NotFoundError('Role not found', 'role_not_found');
      const [target] = await tx.select().from(agentRoleVersions).where(and(eq(agentRoleVersions.roleId, roleId), eq(agentRoleVersions.version, versionNumber))).limit(1);
      if (!target || target.state === 'draft') throw new NotFoundError(`Role has no version ${versionNumber}`, 'role_version_not_found');
      const files = (await versionFiles(tx, target.id)).map((file) => ({ ...file }));
      return publishVersion(tx, role, { manifest: target.manifest, files, changelog, actor, revertedFromVersion: target.version });
    });
    const [role] = await this.core.db.select().from(agentRoles).where(eq(agentRoles.id, roleId)).limit(1);
    await this.announce(role!, out.version, out.previous);
    return out.version;
  }

  // ── agent-facing listing ──────────────────────────────────────────────

  async listForAgent(sessionId: string, token: string, body: unknown) {
    const input = z.object({ proposal_id: z.string().uuid().optional(), status: z.string().max(16).optional() }).strict().parse(body ?? {});
    const { addressId } = await this.core.identity(sessionId, token);
    const db = this.core.db;
    const assignment = await this.core.assignments.activeFor(db, addressId);
    if (input.proposal_id) {
      const [row] = await db.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, input.proposal_id)).limit(1);
      if (!row || (row.authorAddressId !== addressId && row.roleId !== assignment?.roleId)) throw new NotFoundError('Proposal not found', 'proposal_not_found');
      return { proposal: { ...this.view(row), bodies: await this.opBodies(db, row), events: await this.events(db, row.id) }, note: 'Unreviewed content is not part of the role until it is applied.' };
    }
    const scope = assignment ? or(eq(agentRoleProposals.authorAddressId, addressId), and(eq(agentRoleProposals.roleId, assignment.roleId), inArray(agentRoleProposals.status, ROLE_OPEN_PROPOSAL_STATUSES))) : eq(agentRoleProposals.authorAddressId, addressId);
    const rows = await db
      .select()
      .from(agentRoleProposals)
      .where(input.status ? and(scope, eq(agentRoleProposals.status, input.status)) : scope)
      .orderBy(desc(agentRoleProposals.createdAt))
      .limit(50);
    return { proposals: rows.map((row) => this.view(row)), note: 'Open proposals are unreviewed and not part of the role.' };
  }

  // ── the worker ────────────────────────────────────────────────────────

  /** Advance everything that is due. Safe to run concurrently with itself only by the caller's guard. */
  async processDue(now = new Date()) {
    const db = this.core.db;
    // Same second precision as nowIso(), or a row written this second sorts after `now`.
    const nowText = isoOffsetSeconds(0, now);
    const due = await db
      .select()
      .from(agentRoleProposals)
      .where(and(eq(agentRoleProposals.status, 'checking'), lte(agentRoleProposals.nextAttemptAt, nowText)))
      .orderBy(asc(agentRoleProposals.createdAt))
      .limit(20);
    for (const row of due) {
      if (!row.gateResults) await this.runGates(row.id);
      else await this.judgeStage(row, false);
    }
    const reviewing = await db.select().from(agentRoleProposals).where(eq(agentRoleProposals.status, 'in_review')).limit(100);
    for (const row of reviewing) {
      const waitedSince = Date.parse(row.reviewRequestedAt ?? row.updatedAt);
      if (row.risk === 'modifying' && Number.isFinite(waitedSince) && now.getTime() - waitedSince > ROLE_REVIEW_FALLBACK_SECONDS * 1000) {
        const strictDone = (row.judge as { strict?: boolean } | null)?.strict === true;
        if (!strictDone) await this.judgeStage(row, true);
        continue;
      }
      await this.assignReviewer(row.id);
    }
    const stale = await db
      .select()
      .from(agentRoleProposals)
      .where(and(inArray(agentRoleProposals.status, ['in_review', 'held']), lte(agentRoleProposals.updatedAt, isoOffsetSeconds(-ROLE_PROPOSAL_EXPIRY_SECONDS, now))))
      .limit(50);
    for (const row of stale) {
      await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(agentRoleProposals).where(and(eq(agentRoleProposals.id, row.id), ne(agentRoleProposals.status, 'applied'))).limit(1).for('update');
        if (locked && locked.version === row.version) await this.transition(tx, locked, { status: 'superseded', decisionNote: 'expired without a decision' }, 'expired', SERVER);
      });
    }
  }
}
