/**
 * Slop jobs: project-bound, versioned UI/UX review jobs for agents
 * (docs/interface-api.md#slop-jobs, docs/MCP.md).
 *
 * An agent creates a job in a CoCo project, uploads files (from a transfer id
 * or inline text) and a description, and starts runs:
 *   quick  the vendored slop-detector `scan` over the source files, executed by
 *          the isolated `slop-worker` container (no network, read-only root);
 *   full   the same scan, then a Fleet Advisor review over sources, screenshots,
 *          description, guidelines and the quick report, validated by
 *          `slop report --review` in the worker before it is recorded.
 * Uploading an existing path adds a revision; runs pin a snapshot and keep
 * their results, so files and runs can be diffed. A job closes on request or
 * after 24 h without activity; closing hard-deletes it.
 *
 * Tables are `cold` (direct SQL, not owner state). Blob bytes live under
 * DATA_ROOT/slop/blobs/<aa>/<sha256>; run workspaces under
 * DATA_ROOT/slop/runs/<run-id>/ and are removed when the run ends.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { RouteContext } from '../routes/index.js';
import { coordProjects, slopJobFiles, slopJobs, slopRuns, type Host, type SlopJob, type SlopRun } from '../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { decrypt } from '../security/secret-box.js';
import { wsPublisher } from '../ws/publisher.js';
import { mutateOwnerState, ownerRuntimeFor } from '../control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../control-plane/persistence.js';
import { currentNativePrincipal } from '../control-plane/state/native-principal.js';
import { AgentTransfersService } from './agent-transfers.js';
import { SettingsService } from './settings.js';
import { AdvisorService, type AdvisorCaller } from './advisor.js';
import { parseAdvisorVerdict } from './advisor-delivery.js';
import { createAgentMessagingService } from './agent-messaging.js';
import {
  SLOP_LIMITS,
  inferSlopKind,
  isLikelyText,
  normalizeSlopPath,
  pathsCollide,
  type SlopFileKind,
} from './slop-jobs/paths.js';
import { MAX_DIFF_LINES, unifiedDiff } from './slop-jobs/diff.js';
import { buildTar, tarName, type TarEntry } from './slop-jobs/tar.js';
import { parseReviewReply, reviewQuestion, stripReviewBlock } from './slop-jobs/review.js';
import { slopAdvisorEvents } from './slop-jobs/advisor-hook.js';

const now = () => new Date().toISOString();
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TERMINAL = ['completed', 'incomplete', 'failed'] as const;
const MAX_WAIT_SECONDS = 25;
const BUNDLE_TTL_SECONDS = 2 * 3600;

type Snapshot = Record<string, { rev: number; sha256: string; kind: SlopFileKind; size: number }>;
interface SlopReport {
  version: number;
  findings: Array<Record<string, unknown> & { id: string; priority: string; kind: string; rule: string; location: string }>;
  errors: string[];
  coverage: string[];
  [key: string]: unknown;
}
interface WorkerResult {
  state: 'done' | 'failed';
  exit_code: number;
  slop_version?: string;
  report?: SlopReport | null;
  stderr?: string;
  guidelines_sha256?: string;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (required) throw new ValidationError(`${key} is required`, { param: key });
  return '';
}

function waitSeconds(args: Record<string, unknown>, fallback: number): number {
  const raw = args['wait_seconds'];
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new ValidationError('wait_seconds must be 0-25');
  return Math.min(MAX_WAIT_SECONDS, Math.floor(value));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SlopJobsService {
  private readonly dataRoot: string;
  private readonly transfers: AgentTransfersService;
  private readonly advisor: AdvisorService;
  private readonly advancing = new Map<string, Promise<void>>();

  constructor(private readonly ctx: RouteContext) {
    this.dataRoot = ctx.env.DATA_ROOT ?? '/app/storage';
    this.transfers = new AgentTransfersService({
      db: ctx.db,
      settings: new SettingsService(ctx.db),
      dataRoot: this.dataRoot,
    });
    this.advisor = new AdvisorService(ctx);
  }

  // ---------------------------------------------------------------- storage

  private blobPath(digest: string) {
    return join(this.dataRoot, 'slop', 'blobs', digest.slice(0, 2), digest);
  }
  runDir(runId: string) {
    return join(this.dataRoot, 'slop', 'runs', runId);
  }

  private async writeAtomic(path: string, data: Buffer | string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  }

  private async storeBlob(data: Buffer): Promise<string> {
    const digest = sha256(data);
    const path = this.blobPath(digest);
    try {
      await stat(path);
    } catch {
      await this.writeAtomic(path, data);
    }
    return digest;
  }

  private async readBlob(digest: string): Promise<Buffer> {
    try {
      return await readFile(this.blobPath(digest));
    } catch {
      throw new ConflictError(`Blob ${digest.slice(0, 12)} is missing from the slop store`, 'slop_blob_missing');
    }
  }

  /**
   * Slop tables are cold, but after hydration the public pool handle refuses
   * writes: every write runs inside an owner command's transaction (same rule
   * as external-clients/write.ts). Without an owner (tests) the handle is used.
   */
  private async write(operation: (tx: PersistenceTransaction) => Promise<unknown>): Promise<void> {
    const runtime = ownerRuntimeFor(this.ctx.db);
    if (!runtime) {
      await operation(this.ctx.db as unknown as PersistenceTransaction);
      return;
    }
    await mutateOwnerState(runtime, {
      kind: 'slop_jobs.write',
      payload: {},
      prepare(c) {
        c.write(async (tx) => {
          await operation(tx);
        });
        return null;
      },
    });
  }

  // ----------------------------------------------------------- identities

  private actor(host: Host): string {
    const principal = currentNativePrincipal();
    return principal ? `session:${principal.sessionId}` : `host:${host.id}`;
  }

  /** The calling agent as the advisor needs it; only native sessions with an agent address qualify. */
  private async advisorCaller(): Promise<AdvisorCaller> {
    const principal = currentNativePrincipal();
    if (!principal)
      throw new ForbiddenError(
        'Full slop runs need an agent identity: call from a managed session (cdx/clx/cgx with agent messaging).',
        'slop_agent_identity_required',
      );
    const messaging = createAgentMessagingService(this.ctx.db, this.ctx.env, this.ctx.keyring);
    const { session, host } = await messaging.authenticateBridge(principal.sessionId, principal.bridgeToken);
    if (!session.agentBusAddressId) throw new ForbiddenError('Agent identity required', 'slop_agent_identity_required');
    return { session, host } as AdvisorCaller;
  }

  // ------------------------------------------------------------- lookups

  private async project(slugRaw: unknown): Promise<{ id: number; slug: string }> {
    const slug = String(slugRaw ?? '').trim();
    if (!slug) throw new ValidationError('project is required', { param: 'project' });
    if (!SLUG_RE.test(slug)) throw new ValidationError('project must be a project slug', { param: 'project' });
    const owner = ownerRuntimeFor(this.ctx.db);
    if (owner) {
      const row = owner.state
        .snapshot()
        .table('coordProjects')
        .all()
        .find((p) => p.slug === slug);
      if (row) return { id: Number(row.id), slug: row.slug };
    } else {
      const [row] = await this.ctx.db
        .select({ id: coordProjects.id, slug: coordProjects.slug })
        .from(coordProjects)
        .where(eq(coordProjects.slug, slug))
        .limit(1);
      if (row) return row;
    }
    throw new NotFoundError('Project not found', 'project_not_found');
  }

  private async projectSlug(projectId: number): Promise<string | null> {
    const owner = ownerRuntimeFor(this.ctx.db);
    if (owner) return owner.state.snapshot().table('coordProjects').get(projectId)?.slug ?? null;
    const [row] = await this.ctx.db
      .select({ slug: coordProjects.slug })
      .from(coordProjects)
      .where(eq(coordProjects.id, projectId))
      .limit(1);
    return row?.slug ?? null;
  }

  private async job(jobIdRaw: unknown, touch = true): Promise<SlopJob> {
    const jobId = String(jobIdRaw ?? '').trim();
    if (!UUID_RE.test(jobId)) throw new ValidationError('job_id must be a slop job id', { param: 'job_id' });
    const [row] = await this.ctx.db.select().from(slopJobs).where(eq(slopJobs.id, jobId.toLowerCase())).limit(1);
    if (!row || row.status !== 'open') throw new NotFoundError('Slop job not found or closed', 'slop_job_not_found');
    if ((await this.projectSlug(row.projectId)) === null) {
      await this.purge(row.id);
      throw new NotFoundError('Slop job not found or closed', 'slop_job_not_found');
    }
    if (touch) {
      const at = now();
      await this.write((tx) => tx.update(slopJobs).set({ lastActivityAt: at }).where(eq(slopJobs.id, row.id)));
      row.lastActivityAt = at;
    }
    return row;
  }

  /** Latest revision per path, removals excluded. */
  private async currentFiles(jobId: string) {
    const rows = await this.ctx.db
      .select()
      .from(slopJobFiles)
      .where(eq(slopJobFiles.jobId, jobId))
      .orderBy(asc(slopJobFiles.path), desc(slopJobFiles.rev));
    const latest = new Map<string, (typeof rows)[number] & { revisions: number }>();
    for (const row of rows) {
      const seen = latest.get(row.path);
      if (seen) seen.revisions++;
      else latest.set(row.path, { ...row, revisions: 1 });
    }
    return { all: rows, latest: [...latest.values()] };
  }

  private publish(projectSlug: string | null, jobId: string, action: string) {
    wsPublisher.publish('project.slop.changed', { slug: projectSlug, job_id: jobId, action });
  }

  private expiresAt(job: SlopJob) {
    return new Date(Date.parse(job.lastActivityAt) + SLOP_LIMITS.idleHours * 3600_000).toISOString();
  }

  private jobView(job: SlopJob, projectSlug: string | null) {
    return {
      job_id: job.id,
      project: projectSlug,
      title: job.title,
      status: job.status,
      description_rev: job.descriptionRev,
      has_description: Boolean(job.description),
      runs: job.runCount,
      created_by: job.createdBy,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      last_activity_at: job.lastActivityAt,
      expires_at: this.expiresAt(job),
    };
  }

  // ------------------------------------------------------------ MCP tools

  async create(args: Record<string, unknown>, host: Host) {
    const project = await this.project(args['project']);
    const title = str(args, 'title').slice(0, 160);
    const description = typeof args['description'] === 'string' ? args['description'] : '';
    if (Buffer.byteLength(description) > SLOP_LIMITS.maxDescriptionBytes)
      throw new ValidationError(`description is limited to ${SLOP_LIMITS.maxDescriptionBytes} bytes`);
    const at = now();
    const row: typeof slopJobs.$inferInsert = {
      id: randomUUID(),
      projectId: project.id,
      title,
      description: description || null,
      descriptionRev: description ? 1 : 0,
      status: 'open',
      createdBy: this.actor(host),
      createdHostId: host.id,
      runCount: 0,
      createdAt: at,
      updatedAt: at,
      lastActivityAt: at,
    };
    await this.write((tx) => tx.insert(slopJobs).values(row));
    this.publish(project.slug, row.id, 'created');
    return { job: this.jobView(row as SlopJob, project.slug) };
  }

  async describe(args: Record<string, unknown>, host: Host) {
    const job = await this.job(args['job_id']);
    const description = typeof args['description'] === 'string' ? args['description'] : '';
    if (Buffer.byteLength(description) > SLOP_LIMITS.maxDescriptionBytes)
      throw new ValidationError(`description is limited to ${SLOP_LIMITS.maxDescriptionBytes} bytes`);
    if ((job.description ?? '') === description) return { job: this.jobView(job, await this.projectSlug(job.projectId)), changed: false };
    const at = now();
    await this.write((tx) =>
      tx.update(slopJobs)
      .set({ description: description || null, descriptionRev: job.descriptionRev + 1, updatedAt: at })
      .where(eq(slopJobs.id, job.id)));
    void host;
    const updated = { ...job, description: description || null, descriptionRev: job.descriptionRev + 1, updatedAt: at };
    const slug = await this.projectSlug(job.projectId);
    this.publish(slug, job.id, 'described');
    return { job: this.jobView(updated, slug), changed: true };
  }

  async put(args: Record<string, unknown>, host: Host) {
    const job = await this.job(args['job_id']);
    const path = normalizeSlopPath(args['path']);
    const { all, latest } = await this.currentFiles(job.id);
    const current = latest.find((f) => f.path === path);
    const nextRev = (all.filter((f) => f.path === path).reduce((max, f) => Math.max(max, f.rev), 0) || 0) + 1;
    const actor = this.actor(host);

    if (args['remove'] === true) {
      if (!current || current.sha256 === null) throw new NotFoundError(`No current file at ${path}`, 'slop_file_not_found');
      await this.write((tx) => tx.insert(slopJobFiles).values({
        jobId: job.id, path, rev: nextRev, kind: current.kind, sha256: null, sizeBytes: 0, createdBy: actor, createdAt: now(),
      }));
      await this.write((tx) => tx.update(slopJobs).set({ updatedAt: now() }).where(eq(slopJobs.id, job.id)));
      this.publish(await this.projectSlug(job.projectId), job.id, 'file_removed');
      return { path, rev: nextRev, removed: true };
    }

    const transferId = str(args, 'transfer_id', false);
    const content = args['content'];
    if (Boolean(transferId) === (typeof content === 'string'))
      throw new ValidationError('pass exactly one of transfer_id or content');
    let bytes: Buffer;
    if (typeof content === 'string') {
      bytes = Buffer.from(content, 'utf8');
      if (bytes.length > SLOP_LIMITS.maxInlineBytes)
        throw new ValidationError(`inline content is limited to ${SLOP_LIMITS.maxInlineBytes} bytes; upload larger files with cxx transfer put and pass transfer_id`);
    } else {
      const info = await this.transfers.info(transferId);
      if (info.size_bytes > SLOP_LIMITS.maxFileBytes)
        throw new ValidationError(`files are limited to ${SLOP_LIMITS.maxFileBytes} bytes`);
      const parts: Buffer[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const chunk = await this.transfers.get(transferId, { offset, max_bytes: 4 * 1024 * 1024 });
        parts.push(Buffer.from(chunk.content_b64, 'base64'));
        offset = chunk.next_offset;
      }
      bytes = Buffer.concat(parts);
    }
    if (bytes.length > SLOP_LIMITS.maxFileBytes) throw new ValidationError(`files are limited to ${SLOP_LIMITS.maxFileBytes} bytes`);
    const kind = inferSlopKind(path, args['kind']);
    if (kind !== 'screenshot' && !isLikelyText(bytes))
      throw new ValidationError(`${path} is not UTF-8 text; only screenshots may be binary`);
    if (kind === 'a11y') {
      try {
        JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new ValidationError('a11y files must be JSON exports ({tool, findings[]})');
      }
    }
    const others = latest.filter((f) => f.path !== path && f.sha256 !== null);
    const collision = others.find((f) => pathsCollide(f.path, path));
    if (collision) throw new ConflictError(`${path} collides with ${collision.path} (file vs. directory)`, 'slop_path_collision');
    if (!current || current.sha256 === null) {
      if (others.length + 1 > SLOP_LIMITS.maxJobFiles)
        throw new ConflictError(`a job holds at most ${SLOP_LIMITS.maxJobFiles} current files`, 'slop_job_full');
    }
    const total = others.reduce((sum, f) => sum + f.sizeBytes, 0) + bytes.length;
    if (total > SLOP_LIMITS.maxJobBytes)
      throw new ConflictError(`a job holds at most ${SLOP_LIMITS.maxJobBytes} bytes of current files`, 'slop_job_full');

    const digest = await this.storeBlob(bytes);
    if (current && current.sha256 === digest && current.kind === kind)
      return { path, rev: current.rev, kind, sha256: digest, size_bytes: bytes.length, unchanged: true };
    await this.write((tx) => tx.insert(slopJobFiles).values({
      jobId: job.id, path, rev: nextRev, kind, sha256: digest, sizeBytes: bytes.length, createdBy: actor, createdAt: now(),
    }));
    await this.write((tx) => tx.update(slopJobs).set({ updatedAt: now() }).where(eq(slopJobs.id, job.id)));
    this.publish(await this.projectSlug(job.projectId), job.id, 'file_uploaded');
    return { path, rev: nextRev, kind, sha256: digest, size_bytes: bytes.length, previous_rev: current?.sha256 ? current.rev : null };
  }

  async get(args: Record<string, unknown>) {
    const job = await this.job(args['job_id']);
    const slug = await this.projectSlug(job.projectId);
    const { latest } = await this.currentFiles(job.id);
    const runs = await this.ctx.db
      .select()
      .from(slopRuns)
      .where(eq(slopRuns.jobId, job.id))
      .orderBy(desc(slopRuns.seq))
      .limit(50);
    return {
      job: { ...this.jobView(job, slug), description: job.description },
      files: latest
        .filter((f) => f.sha256 !== null)
        .map((f) => ({ path: f.path, kind: f.kind, rev: f.rev, revisions: f.revisions, sha256: f.sha256, size_bytes: f.sizeBytes, updated_at: f.createdAt })),
      removed: latest.filter((f) => f.sha256 === null).map((f) => ({ path: f.path, rev: f.rev })),
      runs: runs.map((run) => this.runSummary(run)),
    };
  }

  async list(args: Record<string, unknown>) {
    const project = await this.project(args['project']);
    const rows = await this.ctx.db
      .select()
      .from(slopJobs)
      .where(and(eq(slopJobs.projectId, project.id), eq(slopJobs.status, 'open')))
      .orderBy(desc(slopJobs.updatedAt))
      .limit(100);
    return { project: project.slug, jobs: rows.map((row) => this.jobView(row, project.slug)) };
  }

  async close(args: Record<string, unknown>) {
    const job = await this.job(args['job_id'], false);
    const slug = await this.projectSlug(job.projectId);
    await this.purge(job.id);
    this.publish(slug, job.id, 'closed');
    return { job_id: job.id, closed: true };
  }

  // ----------------------------------------------------------------- runs

  async run(args: Record<string, unknown>, host: Host) {
    const job = await this.job(args['job_id']);
    const mode = str(args, 'mode');
    if (mode !== 'quick' && mode !== 'full') throw new ValidationError('mode must be quick or full', { param: 'mode' });
    const clientMessageId = str(args, 'client_message_id').toLowerCase();
    if (!UUID_RE.test(clientMessageId)) throw new ValidationError('client_message_id must be a UUID');
    const clientKey = `${job.id}:${clientMessageId}`;
    const [prior] = await this.ctx.db.select().from(slopRuns).where(eq(slopRuns.clientKey, clientKey)).limit(1);
    if (prior) return this.runResponse(prior, waitSeconds(args, 0));

    const caller = mode === 'full' ? await this.advisorCaller() : null;
    if (caller) {
      const availability = await this.advisor.availability();
      if (!availability.enabled)
        throw new ConflictError(`Fleet Advisor is unavailable (${availability.reason})`, 'advisor_unavailable');
      if (!(await this.transfers.getEnabled()))
        throw new ConflictError('Full runs hand the bundle to the advisor as a transfer; File Transfer is disabled.', 'slop_transfers_disabled');
    }
    const { latest } = await this.currentFiles(job.id);
    const files = latest.filter((f) => f.sha256 !== null && (mode === 'full' || f.kind === 'source'));
    if (!files.some((f) => f.kind === 'source'))
      throw new ConflictError('The job has no source files to scan; upload at least one with slop_job_put', 'slop_job_empty');
    const snapshot: Snapshot = Object.fromEntries(
      files.map((f) => [f.path, { rev: f.rev, sha256: f.sha256!, kind: f.kind as SlopFileKind, size: f.sizeBytes }]),
    );

    const id = randomUUID(),
      at = now();
    let seq = 0;
    await this.write(async (tx) => {
      await tx.update(slopJobs).set({ runCount: sql`${slopJobs.runCount} + 1`, updatedAt: at }).where(eq(slopJobs.id, job.id));
      const [counted] = await tx.select({ runCount: slopJobs.runCount }).from(slopJobs).where(eq(slopJobs.id, job.id));
      seq = counted!.runCount;
      await tx.insert(slopRuns).values({
        id, jobId: job.id, seq, clientKey, mode, status: 'scanning', snapshotJson: JSON.stringify(snapshot),
        descriptionRev: job.descriptionRev, createdBy: this.actor(host), createdAt: at, updatedAt: at,
        advisorCallerId: caller?.session.agentBusAddressId ?? null,
        advisorEngine: typeof args['engine'] === 'string' ? args['engine'] : null,
        advisorModel: typeof args['model'] === 'string' ? args['model'] : null,
      });
    });
    const slug = await this.projectSlug(job.projectId);
    this.publish(slug, job.id, 'run_started');

    const dir = this.runDir(id);
    try {
      for (const [path, file] of Object.entries(snapshot)) {
        const base = file.kind === 'source' ? 'tree' : 'out';
        await this.writeAtomic(join(dir, base, path), await this.readBlob(file.sha256));
      }
      await this.writeAtomic(join(dir, 'scan.request.json'), JSON.stringify({ task: 'scan', full: mode === 'full' }));
    } catch (error) {
      await this.finish(id, 'failed', { error: `Could not prepare the run directory: ${String(error).slice(0, 500)}` });
      throw error;
    }

    if (mode === 'quick') return this.runResponse(await this.runRow(id), waitSeconds(args, 20));

    // Full: the advisor needs the caller's bridge identity, which only exists in
    // this request. Wait for the deterministic scan, then hand over the bundle.
    const scan = await this.waitForResult(dir, 'scan', 60);
    if (!scan) {
      await this.finish(id, 'failed', { error: 'The slop worker did not finish the scan within 60 s; is the slop-worker service running?' });
      return this.runResponse(await this.runRow(id), 0);
    }
    await this.recordScan(id, scan);
    if (scan.state !== 'done' || !scan.report) {
      await this.finish(id, 'failed', { error: `slop scan failed (exit ${scan.exit_code}): ${(scan.stderr ?? '').slice(-500)}` });
      return this.runResponse(await this.runRow(id), 0);
    }
    try {
      await this.askAdvisor(await this.runRow(id), job, scan, caller!, args);
    } catch (error) {
      await this.finish(id, 'failed', { error: `Advisor review could not start: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000) });
    }
    return this.runResponse(await this.runRow(id), 0);
  }

  async result(args: Record<string, unknown>) {
    const job = await this.job(args['job_id']);
    const run = await this.resolveRun(job.id, args['run']);
    const response = await this.runResponse(run, waitSeconds(args, 0));
    const fresh = await this.runRow(run.id);
    const report = this.parseJson<SlopReport>(fresh.reportJson);
    const format = args['format'] === 'markdown' ? 'markdown' : 'json';
    if (format === 'markdown') return { ...response, markdown: this.markdown(job, fresh, report) };
    return { ...response, report, quick_report: fresh.mode === 'full' ? this.parseJson(fresh.scanJson) : undefined };
  }

  async diff(args: Record<string, unknown>) {
    const job = await this.job(args['job_id']);
    if (args['path'] !== undefined) return this.fileDiff(job, args);
    // Without path or runs: the two latest runs (previous → latest).
    const runs = await this.ctx.db.select().from(slopRuns).where(eq(slopRuns.jobId, job.id)).orderBy(desc(slopRuns.seq));
    const pick = (raw: unknown, fallbackIndex: number) => {
      if (raw === undefined || raw === null || raw === '') return runs[fallbackIndex];
      const key = String(raw).toLowerCase();
      return runs.find((run) => run.id === key || String(run.seq) === key);
    };
    const to = pick(args['to_run'], 0),
      from = pick(args['from_run'], 1);
    if (!from || !to) throw new NotFoundError('Both runs must exist; a run diff needs at least two runs', 'slop_run_not_found');
    const a = this.parseJson<SlopReport>(from.reportJson),
      b = this.parseJson<SlopReport>(to.reportJson);
    const fa = new Map((a?.findings ?? []).map((f) => [f.id, f])),
      fb = new Map((b?.findings ?? []).map((f) => [f.id, f]));
    const brief = (f: SlopReport['findings'][number]) => ({ id: f.id, rule: f.rule, priority: f.priority, kind: f.kind, location: f.location, message: f['message'] });
    const sa = this.parseJson<Snapshot>(from.snapshotJson) ?? {},
      sb = this.parseJson<Snapshot>(to.snapshotJson) ?? {};
    return {
      from: this.runSummary(from),
      to: this.runSummary(to),
      findings: {
        new: [...fb.values()].filter((f) => !fa.has(f.id)).map(brief),
        resolved: [...fa.values()].filter((f) => !fb.has(f.id)).map(brief),
        unchanged: [...fb.values()].filter((f) => fa.has(f.id)).length,
      },
      files: {
        added: Object.keys(sb).filter((p) => !sa[p]),
        removed: Object.keys(sa).filter((p) => !sb[p]),
        changed: Object.keys(sb)
          .filter((p) => sa[p] && sa[p]!.sha256 !== sb[p]!.sha256)
          .map((p) => ({ path: p, from_rev: sa[p]!.rev, to_rev: sb[p]!.rev })),
      },
      description_changed: from.descriptionRev !== to.descriptionRev,
      note: 'Finding ids derive from rule, location and evidence: moved code shows up as resolved + new.',
    };
  }

  private async fileDiff(job: SlopJob, args: Record<string, unknown>) {
    const path = normalizeSlopPath(args['path']);
    const revs = await this.ctx.db
      .select()
      .from(slopJobFiles)
      .where(and(eq(slopJobFiles.jobId, job.id), eq(slopJobFiles.path, path)))
      .orderBy(desc(slopJobFiles.rev));
    if (!revs.length) throw new NotFoundError(`No revisions for ${path}`, 'slop_file_not_found');
    const revOf = (raw: unknown, fallback: (typeof revs)[number] | undefined) => {
      if (raw === undefined || raw === null || raw === '') return fallback;
      const n = Number(raw);
      return revs.find((r) => r.rev === n);
    };
    const to = revOf(args['to_rev'], revs[0]),
      from = revOf(args['from_rev'], revs.find((r) => to && r.rev < to.rev));
    if (!to) throw new NotFoundError('to_rev does not exist', 'slop_file_not_found');
    const meta = { path, from_rev: from?.rev ?? null, to_rev: to.rev, revisions: revs.map((r) => ({ rev: r.rev, sha256: r.sha256, size_bytes: r.sizeBytes, kind: r.kind, created_at: r.createdAt, removed: r.sha256 === null })) };
    const before = from?.sha256 ? await this.readBlob(from.sha256) : Buffer.alloc(0),
      after = to.sha256 ? await this.readBlob(to.sha256) : Buffer.alloc(0);
    if (to.kind === 'screenshot' || (from && from.kind === 'screenshot') || !isLikelyText(before) || !isLikelyText(after))
      return { ...meta, binary: true, changed: (from?.sha256 ?? null) !== to.sha256, from_sha256: from?.sha256 ?? null, to_sha256: to.sha256 };
    try {
      const result = unifiedDiff(before.toString('utf8'), after.toString('utf8'), from ? `${path}@${from.rev}` : '/dev/null', to.sha256 ? `${path}@${to.rev}` : '/dev/null');
      return { ...meta, binary: false, ...result };
    } catch (error) {
      if (error instanceof RangeError) throw new ValidationError(`diff inputs are limited to ${MAX_DIFF_LINES} lines`);
      throw error;
    }
  }

  // --------------------------------------------------------- run plumbing

  private parseJson<T = unknown>(value: string | null | undefined): T | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  private async runRow(id: string): Promise<SlopRun> {
    const [row] = await this.ctx.db.select().from(slopRuns).where(eq(slopRuns.id, id)).limit(1);
    if (!row) throw new NotFoundError('Slop run not found', 'slop_run_not_found');
    return row;
  }

  private async resolveRun(jobId: string, raw: unknown): Promise<SlopRun> {
    const rows = await this.ctx.db.select().from(slopRuns).where(eq(slopRuns.jobId, jobId)).orderBy(desc(slopRuns.seq));
    if (!rows.length) throw new NotFoundError('This job has no runs yet; start one with slop_job_run', 'slop_run_not_found');
    if (raw === undefined || raw === null || raw === '') return rows[0]!;
    const key = String(raw).toLowerCase();
    const row = rows.find((run) => run.id === key || String(run.seq) === key);
    if (!row) throw new NotFoundError('Slop run not found', 'slop_run_not_found');
    return row;
  }

  private counts(report: SlopReport | null) {
    const counts = { P0: 0, P1: 0, P2: 0, measured: 0, review: 0 } as Record<string, number>;
    for (const f of report?.findings ?? []) {
      counts[f.priority] = (counts[f.priority] ?? 0) + 1;
      counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    }
    return counts;
  }

  runSummary(run: SlopRun) {
    const report = this.parseJson<SlopReport>(run.reportJson);
    return {
      run_id: run.id,
      seq: run.seq,
      mode: run.mode,
      status: run.status,
      exit_code: run.exitCode,
      findings: report ? report.findings.length : null,
      counts: report ? this.counts(report) : null,
      errors: report?.errors?.length ?? null,
      verdict: this.parseJson<{ verdict?: string; summary?: string }>(run.verdictJson),
      slop_version: run.slopVersion,
      guidelines_sha256: run.guidelinesSha256,
      advisor_session_id: run.advisorSessionId,
      error: run.error,
      created_at: run.createdAt,
      completed_at: run.completedAt,
    };
  }

  private async runResponse(run: SlopRun, wait: number) {
    const deadline = Date.now() + wait * 1000;
    let current = run;
    while (!TERMINAL.includes(current.status as (typeof TERMINAL)[number])) {
      await this.advance(current.id);
      current = await this.runRow(current.id);
      if (TERMINAL.includes(current.status as (typeof TERMINAL)[number]) || Date.now() >= deadline) break;
      await sleep(400);
    }
    const summary = this.runSummary(current);
    const pendingNote =
      current.status === 'reviewing'
        ? 'The Fleet Advisor is reviewing; its answer also reaches you as an ADVISOR/1 message. Fetch the validated result with slop_job_result (wait_seconds up to 25).'
        : current.status === 'scanning' || current.status === 'validating'
          ? 'Still running; call slop_job_result with wait_seconds to wait for it.'
          : undefined;
    return { run: summary, ...(pendingNote ? { next: pendingNote } : {}) };
  }

  private async readResult(dir: string, task: string): Promise<WorkerResult | null> {
    try {
      return JSON.parse(await readFile(join(dir, `${task}.result.json`), 'utf8')) as WorkerResult;
    } catch {
      return null;
    }
  }

  private async waitForResult(dir: string, task: string, seconds: number): Promise<WorkerResult | null> {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const result = await this.readResult(dir, task);
      if (result || Date.now() >= deadline) return result;
      await sleep(250);
    }
  }

  private async recordScan(runId: string, scan: WorkerResult) {
    await this.write((tx) =>
      tx.update(slopRuns)
      .set({
        scanJson: scan.report ? JSON.stringify(scan.report) : null,
        slopVersion: scan.slop_version ?? null,
        guidelinesSha256: scan.guidelines_sha256 ?? null,
        exitCode: scan.exit_code,
        updatedAt: now(),
      })
      .where(eq(slopRuns.id, runId)));
  }

  private async finish(runId: string, status: (typeof TERMINAL)[number], extra: Partial<typeof slopRuns.$inferInsert> = {}) {
    const at = now();
    const [run] = await this.ctx.db.select().from(slopRuns).where(eq(slopRuns.id, runId)).limit(1);
    if (!run || TERMINAL.includes(run.status as (typeof TERMINAL)[number])) return;
    await this.write((tx) =>
      tx.update(slopRuns)
      .set({ ...extra, status, updatedAt: at, completedAt: at })
      .where(and(eq(slopRuns.id, runId), eq(slopRuns.status, run.status))));
    await rm(this.runDir(runId), { recursive: true, force: true }).catch(() => {});
    if (run.advisorSessionId && run.advisorCallerId)
      await this.advisor.closeFor(run.advisorCallerId, run.advisorSessionId).catch(() => {});
    const [job] = await this.ctx.db.select().from(slopJobs).where(eq(slopJobs.id, run.jobId)).limit(1);
    if (job) {
      await this.write((tx) => tx.update(slopJobs).set({ updatedAt: at }).where(eq(slopJobs.id, job.id)));
      this.publish(await this.projectSlug(job.projectId), job.id, 'run_finished');
    }
  }

  private async askAdvisor(run: SlopRun, job: SlopJob, scan: WorkerResult, caller: AdvisorCaller, args: Record<string, unknown>) {
    const dir = this.runDir(run.id);
    const snapshot = this.parseJson<Snapshot>(run.snapshotJson) ?? {};
    const entries: TarEntry[] = [];
    const manifest: Array<Record<string, unknown>> = [];
    for (const [path, file] of Object.entries(snapshot)) {
      const prefix = file.kind === 'source' ? 'tree' : 'shots';
      const name = `${prefix}/${tarName(path)}`;
      entries.push({ name, data: await this.readBlob(file.sha256) });
      manifest.push({ path, kind: file.kind, rev: file.rev, sha256: file.sha256, archive_name: name });
    }
    entries.push({ name: 'guidelines.md', data: await readFile(join(dir, 'guidelines.md')) });
    entries.push({ name: 'quick-report.json', data: Buffer.from(JSON.stringify(scan.report, null, 2)) });
    if (job.description) entries.push({ name: 'description.md', data: Buffer.from(job.description) });
    entries.push({
      name: 'MANIFEST.json',
      data: Buffer.from(JSON.stringify({ job_id: job.id, title: job.title, run: run.seq, slop_version: scan.slop_version, files: manifest }, null, 2)),
    });
    const tar = buildTar(entries);
    const bundleName = `slop-${run.id}.tar`;
    let transferId: string | null = null;
    for (let offset = 0; offset < tar.length || offset === 0; ) {
      const chunk = tar.subarray(offset, offset + 4 * 1024 * 1024);
      const put = await this.transfers.put(
        {
          ...(transferId ? { id: transferId, offset } : { name: bundleName, ttl_seconds: BUNDLE_TTL_SECONDS, mime_type: 'application/x-tar', description: `Slop job ${job.id} run ${run.seq} review bundle`, expected_size_bytes: tar.length }),
          content_b64: chunk.toString('base64'),
          final: offset + chunk.length >= tar.length,
        },
        null,
      );
      transferId = put.transfer.id;
      offset += chunk.length;
      if (offset >= tar.length) break;
    }
    const question = reviewQuestion({
      jobTitle: job.title,
      runSeq: run.seq,
      transferId: transferId!,
      bundleName,
      sourceCount: Object.values(snapshot).filter((f) => f.kind === 'source').length,
      screenshotCount: Object.values(snapshot).filter((f) => f.kind !== 'source').length,
      hasDescription: Boolean(job.description),
    });
    const ask: Record<string, unknown> = { question, kind: 'verify', transfer_ids: [transferId], client_message_id: run.id };
    if (typeof args['engine'] === 'string') ask['engine'] = args['engine'];
    if (typeof args['model'] === 'string') ask['model'] = args['model'];
    const view = (await this.advisor.ask(caller, ask)) as { advisor_session_id: string };
    await this.write((tx) =>
      tx.update(slopRuns)
      .set({ status: 'reviewing', advisorSessionId: view.advisor_session_id, updatedAt: now() })
      .where(and(eq(slopRuns.id, run.id), eq(slopRuns.status, 'scanning'))));
  }

  /** Idempotent state machine step for one run; concurrent callers share one promise. */
  advance(runId: string): Promise<void> {
    const running = this.advancing.get(runId);
    if (running) return running;
    const work = this.advanceOnce(runId).finally(() => this.advancing.delete(runId));
    this.advancing.set(runId, work);
    return work;
  }

  private async advanceOnce(runId: string): Promise<void> {
    const [run] = await this.ctx.db.select().from(slopRuns).where(eq(slopRuns.id, runId)).limit(1);
    if (!run || TERMINAL.includes(run.status as (typeof TERMINAL)[number])) return;
    const dir = this.runDir(run.id);
    const age = Date.now() - Date.parse(run.createdAt);
    if (age > SLOP_LIMITS.runTimeoutMinutes * 60_000) {
      await this.finish(run.id, 'failed', { error: `The run did not finish within ${SLOP_LIMITS.runTimeoutMinutes} minutes (stuck in ${run.status}).` });
      return;
    }
    if (run.status === 'scanning') {
      if (run.mode === 'full') {
        // Full runs leave `scanning` inside the request that started them; a
        // run still here after a few minutes lost that request (API restart).
        if (age > 5 * 60_000) await this.finish(run.id, 'failed', { error: 'The run was interrupted before the advisor review started; start a new run.' });
        return;
      }
      const scan = await this.readResult(dir, 'scan');
      if (!scan) return;
      await this.recordScan(run.id, scan);
      if (scan.state !== 'done' || !scan.report) {
        await this.finish(run.id, 'failed', { error: `slop scan failed (exit ${scan.exit_code}): ${(scan.stderr ?? '').slice(-500)}` });
        return;
      }
      await this.finish(run.id, scan.exit_code === 3 ? 'incomplete' : 'completed', { reportJson: JSON.stringify(scan.report) });
      return;
    }
    if (run.status === 'reviewing') {
      if (!run.advisorReplyEnc) return;
      const reply = decrypt(run.advisorReplyEnc, this.ctx.keyring);
      const verdict = run.advisorReplyStatus === 'completed' ? parseAdvisorVerdict(stripReviewBlock(reply)) : null;
      const verdictJson = verdict ? JSON.stringify(verdict) : null;
      if (run.advisorReplyStatus !== 'completed') {
        await this.finish(run.id, 'failed', { verdictJson, error: `The advisor turn ended with status ${run.advisorReplyStatus}.` });
        return;
      }
      const parsed = parseReviewReply(reply);
      if (!parsed) {
        await this.finish(run.id, 'incomplete', {
          verdictJson,
          reportJson: run.scanJson,
          error: 'The advisor answered without a slop-review block; only the quick report is recorded.',
        });
        return;
      }
      await this.writeAtomic(join(dir, 'review.json'), JSON.stringify({ version: 1, findings: parsed.findings }));
      await this.writeAtomic(join(dir, 'report.request.json'), JSON.stringify({ task: 'report' }));
      await this.write((tx) =>
        tx.update(slopRuns)
        .set({ status: 'validating', verdictJson, error: parsed.problems.length ? parsed.problems.join('; ').slice(0, 2000) : null, updatedAt: now() })
        .where(and(eq(slopRuns.id, run.id), eq(slopRuns.status, 'reviewing'))));
      return;
    }
    if (run.status === 'validating') {
      const report = await this.readResult(dir, 'report');
      if (!report) return;
      if (report.state !== 'done' || !report.report) {
        await this.finish(run.id, 'incomplete', {
          reportJson: run.scanJson,
          exitCode: report.exit_code,
          error: [run.error, `Review validation failed (exit ${report.exit_code}): ${(report.stderr ?? '').slice(-600)}`].filter(Boolean).join('; ').slice(0, 2000),
        });
        return;
      }
      await this.finish(run.id, report.exit_code === 3 ? 'incomplete' : 'completed', {
        reportJson: JSON.stringify(report.report),
        exitCode: report.exit_code,
      });
    }
  }

  // ----------------------------------------------------------- lifecycle

  /** Hard delete a job: rows, run directories and blobs no other job references. */
  async purge(jobId: string) {
    const files = await this.ctx.db.select({ sha256: slopJobFiles.sha256 }).from(slopJobFiles).where(eq(slopJobFiles.jobId, jobId));
    const runs = await this.ctx.db
      .select({ id: slopRuns.id, advisorSessionId: slopRuns.advisorSessionId, advisorCallerId: slopRuns.advisorCallerId, status: slopRuns.status })
      .from(slopRuns)
      .where(eq(slopRuns.jobId, jobId));
    await this.write(async (tx) => {
      await tx.delete(slopRuns).where(eq(slopRuns.jobId, jobId));
      await tx.delete(slopJobFiles).where(eq(slopJobFiles.jobId, jobId));
      await tx.delete(slopJobs).where(eq(slopJobs.id, jobId));
    });
    for (const run of runs) {
      await rm(this.runDir(run.id), { recursive: true, force: true }).catch(() => {});
      if (run.advisorSessionId && run.advisorCallerId && !TERMINAL.includes(run.status as (typeof TERMINAL)[number]))
        await this.advisor.closeFor(run.advisorCallerId, run.advisorSessionId).catch(() => {});
    }
    const digests = [...new Set(files.map((f) => f.sha256).filter((d): d is string => Boolean(d)))];
    if (digests.length) {
      const still = await this.ctx.db
        .select({ sha256: slopJobFiles.sha256 })
        .from(slopJobFiles)
        .where(inArray(slopJobFiles.sha256, digests));
      const kept = new Set(still.map((row) => row.sha256));
      for (const digest of digests) if (!kept.has(digest)) await rm(this.blobPath(digest), { force: true }).catch(() => {});
    }
  }

  /** Periodic: advance open runs, expire idle jobs, drop jobs of deleted projects, clear stray run dirs. */
  async sweep() {
    const open = await this.ctx.db
      .select({ id: slopRuns.id })
      .from(slopRuns)
      .where(inArray(slopRuns.status, ['scanning', 'reviewing', 'validating']));
    for (const run of open) await this.advance(run.id).catch(() => {});
    const cutoff = new Date(Date.now() - SLOP_LIMITS.idleHours * 3600_000).toISOString();
    const idle = await this.ctx.db.select().from(slopJobs).where(lt(slopJobs.lastActivityAt, cutoff)).limit(200);
    for (const job of idle) {
      const [active] = await this.ctx.db
        .select({ id: slopRuns.id })
        .from(slopRuns)
        .where(and(eq(slopRuns.jobId, job.id), inArray(slopRuns.status, ['scanning', 'reviewing', 'validating'])))
        .limit(1);
      if (active) continue;
      await this.purge(job.id);
      this.publish(await this.projectSlug(job.projectId), job.id, 'expired');
    }
    const all = await this.ctx.db.select({ id: slopJobs.id, projectId: slopJobs.projectId }).from(slopJobs).limit(2000);
    for (const job of all) if ((await this.projectSlug(job.projectId)) === null) await this.purge(job.id);
    // Run directories without a live run (crash between purge steps).
    try {
      const live = new Set(open.map((run) => run.id));
      for (const name of await readdir(join(this.dataRoot, 'slop', 'runs'))) {
        if (!UUID_RE.test(name) || live.has(name)) continue;
        const [row] = await this.ctx.db.select({ status: slopRuns.status }).from(slopRuns).where(eq(slopRuns.id, name)).limit(1);
        if (!row || TERMINAL.includes(row.status as (typeof TERMINAL)[number]))
          await rm(this.runDir(name), { recursive: true, force: true }).catch(() => {});
      }
    } catch {
      /* no runs directory yet */
    }
  }

  // ---------------------------------------------------------------- admin

  async adminList(slug: string) {
    const project = await this.project(slug);
    const jobs = await this.ctx.db
      .select()
      .from(slopJobs)
      .where(eq(slopJobs.projectId, project.id))
      .orderBy(desc(slopJobs.updatedAt))
      .limit(200);
    const files = jobs.length
      ? await this.ctx.db.select().from(slopJobFiles).where(inArray(slopJobFiles.jobId, jobs.map((j) => j.id)))
      : [];
    const runs = jobs.length
      ? await this.ctx.db.select().from(slopRuns).where(inArray(slopRuns.jobId, jobs.map((j) => j.id))).orderBy(desc(slopRuns.seq))
      : [];
    return {
      project: project.slug,
      idle_hours: SLOP_LIMITS.idleHours,
      jobs: jobs.map((job) => {
        const own = files.filter((f) => f.jobId === job.id);
        const paths = new Map<string, (typeof own)[number]>();
        for (const f of own) if (!paths.has(f.path) || paths.get(f.path)!.rev < f.rev) paths.set(f.path, f);
        const latestRun = runs.find((r) => r.jobId === job.id);
        return {
          ...this.jobView(job, project.slug),
          files: [...paths.values()].filter((f) => f.sha256 !== null).length,
          revisions: own.length,
          latest_run: latestRun ? this.runSummary(latestRun) : null,
        };
      }),
    };
  }

  async adminGet(slug: string, jobId: string) {
    const project = await this.project(slug);
    if (!UUID_RE.test(jobId)) throw new NotFoundError('Slop job not found', 'slop_job_not_found');
    const [job] = await this.ctx.db.select().from(slopJobs).where(and(eq(slopJobs.id, jobId.toLowerCase()), eq(slopJobs.projectId, project.id))).limit(1);
    if (!job) throw new NotFoundError('Slop job not found', 'slop_job_not_found');
    const { latest } = await this.currentFiles(job.id);
    const runs = await this.ctx.db.select().from(slopRuns).where(eq(slopRuns.jobId, job.id)).orderBy(desc(slopRuns.seq));
    return {
      job: { ...this.jobView(job, project.slug), description: job.description },
      files: latest.map((f) => ({ path: f.path, kind: f.kind, rev: f.rev, revisions: f.revisions, sha256: f.sha256, size_bytes: f.sizeBytes, removed: f.sha256 === null, updated_at: f.createdAt })),
      runs: runs.map((run) => ({
        ...this.runSummary(run),
        report: this.parseJson<SlopReport>(run.reportJson),
      })),
    };
  }

  private markdown(job: SlopJob, run: SlopRun, report: SlopReport | null) {
    const lines = [`# Slop run ${run.seq} (${run.mode}) — ${job.title}`, '', `Status: **${run.status}**${run.exitCode !== null ? `, exit ${run.exitCode}` : ''}; slop ${run.slopVersion ?? 'unknown'}.`];
    const verdict = this.parseJson<{ verdict?: string; summary?: string }>(run.verdictJson);
    if (verdict) lines.push(`Advisor verdict: **${verdict.verdict}** — ${verdict.summary ?? ''}`);
    if (run.error) lines.push(`Note: ${run.error}`);
    if (!report) return lines.join('\n');
    for (const priority of ['P0', 'P1', 'P2']) {
      const list = report.findings.filter((f) => f.priority === priority);
      if (!list.length) continue;
      lines.push('', `## ${priority} (${list.length})`);
      for (const f of list)
        lines.push(`- \`${f.location}\` **${f.rule}** (${f.kind}, ${f.id}): ${String(f['message'] ?? '')} — Remedy: ${String(f['remedy'] ?? '')}${f['alternative'] ? ` — Alternative: ${String(f['alternative'])}` : ''}`);
    }
    if (report.errors.length) lines.push('', '## Errors', ...report.errors.map((e) => `- ${e}`));
    if (report.coverage.length) lines.push('', '## Coverage', ...report.coverage.map((c) => `- ${c}`));
    return lines.join('\n');
  }
}

let shared: { db: unknown; service: SlopJobsService } | null = null;
/** One instance per database handle: MCP, admin routes and the sweeper share run promises. */
export function slopJobsService(ctx: RouteContext): SlopJobsService {
  if (!shared || shared.db !== ctx.db) shared = { db: ctx.db, service: new SlopJobsService(ctx) };
  return shared.service;
}

/** Sweeper + advisor-reply listener + worker result watch. */
export function startSlopJobsWorker(
  app: { log: { error: (obj: unknown, msg: string) => void }; addHook: (name: 'onClose', fn: () => Promise<void>) => unknown },
  ctx: RouteContext,
): void {
  const service = slopJobsService(ctx);
  const onReply = (runId: string) => void service.advance(runId).catch((err) => app.log.error({ err }, 'slop advisor reply failed'));
  slopAdvisorEvents.on('reply', onReply);
  const tick = async () => {
    const owner = ownerRuntimeFor(ctx.db);
    try {
      owner?.assertOwner();
    } catch {
      return;
    }
    await service.sweep().catch((err) => app.log.error({ err }, 'slop job sweep failed'));
  };
  const timer = setInterval(() => void tick(), 15_000);
  timer.unref();
  void tick();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    slopAdvisorEvents.off('reply', onReply);
  });
}
