/**
 * Agent file transfer: a fleet-wide, TTL'd pool of arbitrary files.
 *
 * Everything else agents hand each other here is text, and every one of those
 * tables keeps its content in a LONGTEXT column. This one does not: the bytes
 * live on the DATA_ROOT volume and the row holds only metadata and a path. The
 * consequence that shapes this whole module is that a row and its bytes can now
 * disagree, so every destructive step unlinks the file BEFORE it changes the
 * row. A crash in between leaves a live row whose file is already gone, which
 * the next sweep retries harmlessly; the other order would leave an expired row
 * nobody looks at again guarding a file nothing ever deletes. Same retry-token
 * reasoning as `closeFleetWindow()` in insecure-window-admin.ts.
 *
 * EVERY TRANSFER EXPIRES, and that is the feature rather than a limitation.
 * `ttl_seconds` is required, `expires_at` has no "never" sentinel, and the
 * service clamps what the agent asked for to an operator-set maximum — telling
 * the caller it did, because a file that silently vanished four hours early is
 * indistinguishable from a bug. This is not storage and must not become
 * storage: shared memories and repositories are where a file worth keeping goes.
 *
 * Sweeping happens twice over, deliberately. On read, at the top of every
 * listing and every fetch, following the house rule stated in git-director.ts
 * ("a timer nobody can observe is worse than work done by whoever next looks").
 * AND on a timer, from ops/agent-transfers-worker.ts, because alone among the
 * sweepers here this one reclaims disk — the same argument
 * ops/insecure-fleet-window-worker.ts makes for its security deadline. Neither
 * is redundant: the read sweep keeps expired bytes from being served between
 * ticks, the timer keeps a quiet fleet from filling its volume.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { asc, desc, eq, inArray } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { agentTransferEvents, agentTransfers, type AgentTransfer, type Host } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import type { SettingsService } from './settings.js';

export const TRANSFERS_ENABLED_FLAG = 'transfers_module_enabled';
export const TRANSFERS_DEFAULT_TTL_KEY = 'transfers_default_ttl_seconds';
export const TRANSFERS_MAX_TTL_KEY = 'transfers_max_ttl_seconds';
export const TRANSFERS_MAX_FILE_KEY = 'transfers_max_file_bytes';
export const TRANSFERS_QUOTA_KEY = 'transfers_quota_bytes';

export const DEFAULT_TTL_SECONDS = 3600;
export const DEFAULT_MAX_TTL_SECONDS = 86_400;
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * A TTL floor exists so `ttl_seconds: 0` cannot create a transfer that the very
 * next sweep removes — an agent that passes something absurd gets a minute to
 * hand the id over, not a file that was never fetchable.
 */
export const MIN_TTL_SECONDS = 60;
/** The ceiling an operator may raise the max TTL to. A week is not storage; a month is. */
export const HARD_MAX_TTL_SECONDS = 7 * 24 * 3600;
/**
 * The ceiling an operator may raise the per-file cap to. Bounded by Fastify's
 * 32 MiB `bodyLimit` once base64's third is added back, so a chunked upload of
 * a file this size still fits every hop.
 */
export const HARD_MAX_FILE_BYTES = 64 * 1024 * 1024;
/**
 * Decoded bytes per put or get call. Content crosses MCP base64-encoded inside
 * a JSON-RPC envelope, so this is really a cap on message size; anything larger
 * moves in chunks via `offset`, exactly as `shared_memory_read` pages a long
 * document.
 */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export const TRANSFER_STATUS_UPLOADING = 'uploading';
export const TRANSFER_STATUS_LIVE = 'live';
export const TRANSFER_STATUS_EXPIRED = 'expired';
export const TRANSFER_STATUS_DELETED = 'deleted';

/** Statuses whose bytes are still on disk and still count against the quota. */
const HOLDING_STATUSES = [TRANSFER_STATUS_UPLOADING, TRANSFER_STATUS_LIVE];

const STORAGE_DIR = 'transfers';

/**
 * How long a file with no row may sit before the orphan reaper takes it. Long
 * enough that an upload in flight on another worker is never the victim.
 */
const ORPHAN_GRACE_MS = 3_600_000;

export interface AgentTransfersDeps {
  db: Database;
  settings: SettingsService;
  /** DATA_ROOT. Bytes land under `<dataRoot>/transfers/<shard>/<id>`. */
  dataRoot: string;
  now?: () => string;
}

export interface TransferLimits {
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  max_file_bytes: number;
  quota_bytes: number;
}

export interface TransferModuleState extends TransferLimits {
  enabled: boolean;
  updated_at: string | null;
  used_bytes: number;
  live_count: number;
}

export interface TransferView {
  id: string;
  name: string;
  description: string | null;
  mime_type: string | null;
  size_bytes: number;
  content_sha256: string | null;
  status: string;
  source_host_id: number | null;
  uploaded_by: string | null;
  uploaded_from: string | null;
  requested_ttl_seconds: number | null;
  ttl_clamped: boolean;
  download_count: number;
  expires_at: string;
  sealed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransferEventView {
  id: string;
  action: string;
  actor_kind: string;
  actor_label: string | null;
  source_host_id: number | null;
  detail: string | null;
  created_at: string;
}

export interface PutTransferInput {
  id?: unknown;
  name?: unknown;
  content_b64?: unknown;
  ttl_seconds?: unknown;
  mime_type?: unknown;
  description?: unknown;
  offset?: unknown;
  final?: unknown;
  username?: unknown;
  worktree_path?: unknown;
}

export interface PutTransferResult {
  transfer: TransferView;
  /** True when the fleet shortened the requested TTL. Reported, never silent. */
  ttl_clamped: boolean;
  bytes_written: number;
  complete: boolean;
}

export interface GetTransferResult {
  transfer: TransferView;
  content_b64: string;
  offset: number;
  next_offset: number | null;
  truncated: boolean;
}

export interface SweepCounts {
  expired: number;
  bytes_freed: number;
}

export type TransferActor =
  | { kind: 'agent'; label: string | null; hostId: number | null }
  | { kind: 'admin'; label: string | null }
  | { kind: 'system'; label: string };

/**
 * Clamp a requested TTL into the operator's band, reporting whether it moved.
 * Mirrors `clampFleetWindowMinutes()` in insecure-fleet-window.ts, except that
 * this one hands the verdict back rather than swallowing it: the agent needs to
 * know the deadline it actually got.
 */
export function clampTtlSeconds(
  requested: number,
  maxTtl: number,
): { effective: number; clamped: boolean } {
  const ceiling = Math.min(Math.max(Math.trunc(maxTtl), MIN_TTL_SECONDS), HARD_MAX_TTL_SECONDS);
  const asked = Math.trunc(requested);
  if (asked < MIN_TTL_SECONDS) return { effective: MIN_TTL_SECONDS, clamped: true };
  if (asked > ceiling) return { effective: ceiling, clamped: true };
  return { effective: asked, clamped: false };
}

/** Control characters and double quotes, which every header this name reaches would have to escape. */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f"]/;

/**
 * A display name, not a path. The bytes are stored under the transfer's UUID
 * regardless, so this never reaches the filesystem — but it does reach a
 * `Content-Disposition` header and an operator's download folder, so the same
 * traversal guard `normalizeStoredName()` applies in host-projects.ts applies
 * here.
 */
export function normalizeTransferName(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new ValidationError('name is required');
  const flattened = raw.replace(/\\/g, '/');
  const segments = flattened.split('/').filter((part) => part.length > 0);
  const last = segments[segments.length - 1] ?? '';
  if (!last || last === '.' || last === '..') {
    throw new ValidationError('name must be a file name, not a path');
  }
  if (UNSAFE_NAME_CHARS.test(last)) {
    throw new ValidationError('name must not contain control characters or double quotes');
  }
  if (last.length > 255) throw new ValidationError('name must be 255 characters or fewer');
  return last;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer`);
  return trimmed;
}

function requiredInt(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new ValidationError(`${field} must be a number`);
  return Math.trunc(n);
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('content_b64 is required and must be a base64 string');
  }
  const cleaned = value.replace(/\s+/g, '');
  // Buffer.from is famously permissive, so round-trip to catch a truncated or
  // otherwise malformed payload here rather than storing corrupt bytes.
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) {
    throw new ValidationError('content_b64 is not valid base64');
  }
  return buf;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export class AgentTransfersService {
  private readonly now: () => string;

  constructor(private readonly deps: AgentTransfersDeps) {
    this.now = deps.now ?? nowIso;
  }

  // ── module switch and limits ──────────────────────────────────────────────

  async getEnabled(): Promise<boolean> {
    return await this.deps.settings.getFlag(TRANSFERS_ENABLED_FLAG, false);
  }

  async getLimits(): Promise<TransferLimits> {
    const [defaultTtl, maxTtl, maxFile, quota] = await Promise.all([
      this.deps.settings.getInt(TRANSFERS_DEFAULT_TTL_KEY, DEFAULT_TTL_SECONDS),
      this.deps.settings.getInt(TRANSFERS_MAX_TTL_KEY, DEFAULT_MAX_TTL_SECONDS),
      this.deps.settings.getInt(TRANSFERS_MAX_FILE_KEY, DEFAULT_MAX_FILE_BYTES),
      this.deps.settings.getInt(TRANSFERS_QUOTA_KEY, DEFAULT_QUOTA_BYTES),
    ]);
    return {
      default_ttl_seconds: defaultTtl,
      max_ttl_seconds: maxTtl,
      max_file_bytes: maxFile,
      quota_bytes: quota,
    };
  }

  async setLimits(input: Partial<TransferLimits>): Promise<TransferModuleState> {
    const current = await this.getLimits();
    const next: TransferLimits = {
      default_ttl_seconds: input.default_ttl_seconds ?? current.default_ttl_seconds,
      max_ttl_seconds: input.max_ttl_seconds ?? current.max_ttl_seconds,
      max_file_bytes: input.max_file_bytes ?? current.max_file_bytes,
      quota_bytes: input.quota_bytes ?? current.quota_bytes,
    };
    if (next.max_ttl_seconds < MIN_TTL_SECONDS || next.max_ttl_seconds > HARD_MAX_TTL_SECONDS) {
      throw new ValidationError(
        `max_ttl_seconds must be between ${MIN_TTL_SECONDS} and ${HARD_MAX_TTL_SECONDS}`,
      );
    }
    if (
      next.default_ttl_seconds < MIN_TTL_SECONDS ||
      next.default_ttl_seconds > next.max_ttl_seconds
    ) {
      throw new ValidationError(
        `default_ttl_seconds must be between ${MIN_TTL_SECONDS} and max_ttl_seconds (${next.max_ttl_seconds})`,
      );
    }
    if (next.max_file_bytes < 1024 || next.max_file_bytes > HARD_MAX_FILE_BYTES) {
      throw new ValidationError(`max_file_bytes must be between 1024 and ${HARD_MAX_FILE_BYTES}`);
    }
    if (next.quota_bytes < next.max_file_bytes) {
      throw new ValidationError('quota_bytes must be at least max_file_bytes');
    }
    await Promise.all([
      this.deps.settings.setInt(TRANSFERS_DEFAULT_TTL_KEY, next.default_ttl_seconds, {
        publish: false,
      }),
      this.deps.settings.setInt(TRANSFERS_MAX_TTL_KEY, next.max_ttl_seconds, { publish: false }),
      this.deps.settings.setInt(TRANSFERS_MAX_FILE_KEY, next.max_file_bytes, { publish: false }),
      this.deps.settings.setInt(TRANSFERS_QUOTA_KEY, next.quota_bytes, { publish: false }),
    ]);
    wsPublisher.publish('settings.changed', { kind: 'transfers' });
    wsPublisher.publish('transfers.changed', { kind: 'limits' });
    return await this.adminState();
  }

  async adminState(): Promise<TransferModuleState> {
    await this.sweepExpired().catch(() => undefined);
    const meta = await this.deps.settings.getWithMeta(TRANSFERS_ENABLED_FLAG);
    const limits = await this.getLimits();
    const holding = await this.holdingRows();
    return {
      enabled: await this.getEnabled(),
      updated_at: meta.updatedAt,
      ...limits,
      used_bytes: holding.reduce((sum, row) => sum + Number(row.sizeBytes ?? 0), 0),
      live_count: holding.filter((row) => row.status === TRANSFER_STATUS_LIVE).length,
    };
  }

  async setEnabled(enabled: boolean): Promise<TransferModuleState> {
    await this.deps.settings.setFlag(TRANSFERS_ENABLED_FLAG, enabled, { publish: false });
    wsPublisher.publish('settings.changed', { kind: 'transfers', enabled });
    wsPublisher.publish('transfers.changed', { kind: 'state', enabled });
    return await this.adminState();
  }

  /** How many live transfers exist. Used by the AGENTS.md renderer. */
  async availableCount(): Promise<number> {
    const rows = await this.holdingRows();
    return rows.filter((row) => row.status === TRANSFER_STATUS_LIVE).length;
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async list(options: { limit?: number; includeRetired?: boolean } = {}): Promise<TransferView[]> {
    await this.sweepExpired();
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
    const rows = await this.deps.db
      .select()
      .from(agentTransfers)
      .orderBy(desc(agentTransfers.createdAt));
    const keep = options.includeRetired
      ? rows
      : rows.filter((row) => HOLDING_STATUSES.includes(row.status));
    return keep.slice(0, limit).map((row) => this.view(row));
  }

  async info(id: string): Promise<TransferView> {
    await this.sweepExpired();
    return this.view(await this.requireRow(id));
  }

  async get(
    id: string,
    options: { offset?: unknown; max_bytes?: unknown } = {},
  ): Promise<GetTransferResult> {
    await this.sweepExpired();
    const row = await this.requireRow(id);
    if (row.status !== TRANSFER_STATUS_LIVE) {
      throw new ConflictError(
        row.status === TRANSFER_STATUS_UPLOADING
          ? `Transfer ${id} is still being uploaded. Its final chunk has not arrived yet.`
          : `Transfer ${id} is ${row.status} and its bytes are gone.`,
      );
    }
    const size = Number(row.sizeBytes ?? 0);
    const offset = options.offset === undefined ? 0 : requiredInt(options.offset, 'offset');
    if (offset < 0 || offset > size) {
      throw new ValidationError(`offset must be between 0 and ${size}`);
    }
    const requestedMax =
      options.max_bytes === undefined ? MAX_CHUNK_BYTES : requiredInt(options.max_bytes, 'max_bytes');
    if (requestedMax < 1) throw new ValidationError('max_bytes must be at least 1');
    const length = Math.min(requestedMax, MAX_CHUNK_BYTES, size - offset);
    const buf = await this.readSlice(row, offset, length);
    const nextOffset = offset + buf.length;
    const complete = nextOffset >= size;
    await this.recordEvent(
      row.id,
      'downloaded',
      { kind: 'agent', label: null, hostId: null },
      `${buf.length} bytes from offset ${offset}`,
    );
    // Only a fetch that reached the end counts as a download: a chunked read
    // would otherwise inflate the count by however many slices it took.
    if (complete) await this.bumpDownloadCount(row.id);
    return {
      transfer: this.view({
        ...row,
        downloadCount: Number(row.downloadCount ?? 0) + (complete ? 1 : 0),
      }),
      content_b64: buf.toString('base64'),
      offset,
      next_offset: complete ? null : nextOffset,
      truncated: !complete,
    };
  }

  /**
   * The trail for one transfer, oldest first — a trail is read forward in time,
   * and an upload above its downloads is the order that explains itself.
   *
   * Ordering is by `created_at`, which `nowIso()` gives second precision, so two
   * events inside the same second have no defined order between them. That is
   * accepted rather than fixed with a sequence column: adjacent entries one
   * second apart tell an operator the same story either way round, and the
   * question this list answers — who took a copy — does not depend on which of
   * two same-second rows came first. The cap keeps the OLDEST rows when a
   * transfer somehow exceeds it, since the upload is the row worth keeping.
   */
  async events(id: string, limit = 200): Promise<TransferEventView[]> {
    const rows = await this.deps.db
      .select()
      .from(agentTransferEvents)
      .orderBy(asc(agentTransferEvents.createdAt));
    return rows
      .filter((row) => row.transferId === id)
      .slice(0, Math.min(Math.max(Math.trunc(limit), 1), 500))
      .map((row) => ({
        id: row.id,
        action: row.action,
        actor_kind: row.actorKind,
        actor_label: row.actorLabel ?? null,
        source_host_id: row.sourceHostId ?? null,
        detail: row.detail ?? null,
        created_at: row.createdAt,
      }));
  }

  /**
   * A readable stream over a live transfer's bytes, for the admin download
   * route. Separate from `get()` because the console wants the file itself and
   * not a base64 envelope, and because streaming is the whole reason the bytes
   * are on disk rather than in a column.
   */
  async openDownload(
    id: string,
    actor: TransferActor,
  ): Promise<{ transfer: TransferView; stream: ReadStream }> {
    await this.sweepExpired();
    const row = await this.requireRow(id);
    if (row.status !== TRANSFER_STATUS_LIVE) {
      throw new ConflictError(`Transfer ${id} is ${row.status} and its bytes are gone.`);
    }
    const stream = createReadStream(this.absolutePath(row));
    await this.recordEvent(row.id, 'downloaded', actor, null);
    await this.bumpDownloadCount(row.id);
    return {
      transfer: this.view({ ...row, downloadCount: Number(row.downloadCount ?? 0) + 1 }),
      stream,
    };
  }

  // ── writes ────────────────────────────────────────────────────────────────

  async put(input: PutTransferInput, host: Host | null): Promise<PutTransferResult> {
    await this.sweepExpired();
    const limits = await this.getLimits();
    const chunk = decodeBase64(input.content_b64);
    if (chunk.length > MAX_CHUNK_BYTES) {
      throw new ValidationError(
        `A single call carries at most ${formatBytes(MAX_CHUNK_BYTES)}. Send the file in chunks: pass final=false, then call again with the id you were given and offset set to its size_bytes.`,
      );
    }
    const existingId = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null;
    const isFinal = input.final === undefined ? true : input.final === true || input.final === 'true';

    if (existingId) return await this.appendChunk(existingId, chunk, input, isFinal, limits, host);
    return await this.createTransfer(chunk, input, isFinal, limits, host);
  }

  private async createTransfer(
    chunk: Buffer,
    input: PutTransferInput,
    isFinal: boolean,
    limits: TransferLimits,
    host: Host | null,
  ): Promise<PutTransferResult> {
    const name = normalizeTransferName(input.name);
    if (input.ttl_seconds === undefined || input.ttl_seconds === null) {
      throw new ValidationError(
        'ttl_seconds is required. Every transfer expires — pass how long the peer plausibly needs the file, in seconds.',
      );
    }
    const requested = requiredInt(input.ttl_seconds, 'ttl_seconds');
    const { effective, clamped } = clampTtlSeconds(requested, limits.max_ttl_seconds);
    if (chunk.length > limits.max_file_bytes) {
      throw new ValidationError(
        `This file is ${formatBytes(chunk.length)}, over the fleet's ${formatBytes(limits.max_file_bytes)} per-file limit.`,
      );
    }
    await this.requireQuota(chunk.length, limits);

    const id = randomUUID();
    const storagePath = join(STORAGE_DIR, id.slice(0, 2), id);
    const absolute = join(this.deps.dataRoot, storagePath);
    await mkdir(dirname(absolute), { recursive: true });
    // Bytes first, row second: a crash here leaves an orphan file, which
    // reconcileOrphans() collects. A row written first whose bytes never
    // arrived would be a live transfer that fails every fetch.
    await writeFile(absolute, chunk, { flag: 'wx' });

    const now = this.now();
    const row = {
      id,
      name,
      description: optionalText(input.description, 'description', 2000),
      mimeType: optionalText(input.mime_type, 'mime_type', 255),
      sizeBytes: chunk.length,
      contentSha256: isFinal ? createHash('sha256').update(chunk).digest('hex') : null,
      storagePath,
      status: isFinal ? TRANSFER_STATUS_LIVE : TRANSFER_STATUS_UPLOADING,
      sourceHostId: host?.id ?? null,
      uploadedBy: optionalText(input.username, 'username', 255),
      uploadedFrom: optionalText(input.worktree_path, 'worktree_path', 512),
      requestedTtlSeconds: requested,
      downloadCount: 0,
      expiresAt: isoOffsetSeconds(effective),
      sealedAt: isFinal ? now : null,
      purgedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.db.insert(agentTransfers).values(row);
    await this.recordEvent(
      id,
      isFinal ? 'uploaded' : 'appended',
      { kind: 'agent', label: row.uploadedBy, hostId: row.sourceHostId },
      clamped
        ? `${chunk.length} bytes; ttl clamped from ${requested}s to ${effective}s`
        : `${chunk.length} bytes`,
    );
    wsPublisher.publish('transfers.changed', { kind: 'created', id });
    return {
      transfer: this.view(row as AgentTransfer),
      ttl_clamped: clamped,
      bytes_written: chunk.length,
      complete: isFinal,
    };
  }

  private async appendChunk(
    id: string,
    chunk: Buffer,
    input: PutTransferInput,
    isFinal: boolean,
    limits: TransferLimits,
    host: Host | null,
  ): Promise<PutTransferResult> {
    const row = await this.requireRow(id);
    if (row.status !== TRANSFER_STATUS_UPLOADING) {
      throw new ConflictError(
        `Transfer ${id} is ${row.status} and no longer accepts chunks. Start a new transfer instead of appending to a sealed one.`,
      );
    }
    const size = Number(row.sizeBytes ?? 0);
    if (input.offset !== undefined && input.offset !== null) {
      const offset = requiredInt(input.offset, 'offset');
      if (offset !== size) {
        throw new ConflictError(
          `offset ${offset} does not match this transfer's current size ${size}. Resume from ${size}.`,
        );
      }
    }
    const total = size + chunk.length;
    if (total > limits.max_file_bytes) {
      throw new ValidationError(
        `This chunk would take the file to ${formatBytes(total)}, over the fleet's ${formatBytes(limits.max_file_bytes)} per-file limit.`,
      );
    }
    await this.requireQuota(chunk.length, limits);

    const absolute = this.absolutePath(row);
    await appendFile(absolute, chunk);
    const now = this.now();
    const update: Record<string, unknown> = {
      sizeBytes: total,
      status: isFinal ? TRANSFER_STATUS_LIVE : TRANSFER_STATUS_UPLOADING,
      sealedAt: isFinal ? now : null,
      updatedAt: now,
    };
    if (isFinal) update['contentSha256'] = await this.hashFile(absolute);
    await this.deps.db.update(agentTransfers).set(update).where(eq(agentTransfers.id, id));
    await this.recordEvent(
      id,
      isFinal ? 'sealed' : 'appended',
      { kind: 'agent', label: row.uploadedBy ?? null, hostId: host?.id ?? null },
      `${chunk.length} bytes at offset ${size}`,
    );
    wsPublisher.publish('transfers.changed', { kind: isFinal ? 'sealed' : 'appended', id });
    return {
      transfer: this.view({ ...row, ...update } as AgentTransfer),
      ttl_clamped: false,
      bytes_written: chunk.length,
      complete: isFinal,
    };
  }

  /** Retire a transfer early. The bytes go, the row and its audit trail stay. */
  async remove(id: string, actor: TransferActor): Promise<TransferView> {
    const row = await this.requireRow(id);
    if (row.status === TRANSFER_STATUS_DELETED || row.status === TRANSFER_STATUS_EXPIRED) {
      return this.view(row);
    }
    await this.unlink(row);
    const now = this.now();
    const update = { status: TRANSFER_STATUS_DELETED, purgedAt: now, updatedAt: now };
    await this.deps.db.update(agentTransfers).set(update).where(eq(agentTransfers.id, id));
    await this.recordEvent(id, 'deleted', actor, null);
    wsPublisher.publish('transfers.changed', { kind: 'deleted', id });
    return this.view({ ...row, ...update } as AgentTransfer);
  }

  // ── expiry ────────────────────────────────────────────────────────────────

  /**
   * Retire every transfer past its deadline. Idempotent and safe to run
   * concurrently: unlink tolerates a file another sweeper already removed, and
   * the status update is a no-op the second time.
   */
  async sweepExpired(now: string = this.now()): Promise<SweepCounts> {
    const rows = await this.holdingRows();
    const lapsed = rows.filter((row) => row.expiresAt <= now);
    if (lapsed.length === 0) return { expired: 0, bytes_freed: 0 };
    let freed = 0;
    const ids: string[] = [];
    for (const row of lapsed) {
      // Bytes before status, always. See the module header.
      await this.unlink(row);
      freed += Number(row.sizeBytes ?? 0);
      ids.push(row.id);
      await this.recordEvent(
        row.id,
        'expired',
        { kind: 'system', label: 'sweeper' },
        `deadline ${row.expiresAt}`,
      );
    }
    await this.deps.db
      .update(agentTransfers)
      .set({ status: TRANSFER_STATUS_EXPIRED, purgedAt: now, updatedAt: now })
      .where(inArray(agentTransfers.id, ids));
    wsPublisher.publish('transfers.changed', { kind: 'expired', count: ids.length });
    return { expired: ids.length, bytes_freed: freed };
  }

  /**
   * The crash-recovery half: files under the storage tree that no holding row
   * claims. Without it, a process that died between `writeFile` and the row
   * insert leaks a file nothing will ever look at again.
   */
  async reconcileOrphans(): Promise<{ removed: number }> {
    const root = join(this.deps.dataRoot, STORAGE_DIR);
    let shards: string[];
    try {
      shards = await readdir(root);
    } catch {
      return { removed: 0 };
    }
    const claimed = new Set((await this.holdingRows()).map((row) => row.id));
    let removed = 0;
    for (const shard of shards) {
      let names: string[];
      try {
        names = await readdir(join(root, shard));
      } catch {
        continue;
      }
      for (const name of names) {
        if (claimed.has(name)) continue;
        // A file younger than the grace window may belong to an upload still in
        // flight on another worker, so leave it for a later pass than race it.
        try {
          const info = await stat(join(root, shard, name));
          if (Date.now() - info.mtimeMs < ORPHAN_GRACE_MS) continue;
        } catch {
          continue;
        }
        await rm(join(root, shard, name), { force: true });
        removed += 1;
      }
    }
    return { removed };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async holdingRows(): Promise<AgentTransfer[]> {
    // Filtered in JS rather than SQL for the same reason availableCount() in
    // git-director.ts is: the test db-fake ignores WHERE clauses.
    const rows = await this.deps.db.select().from(agentTransfers);
    return rows.filter((row) => HOLDING_STATUSES.includes(row.status));
  }

  private async requireRow(id: string): Promise<AgentTransfer> {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (!trimmed) throw new ValidationError('id is required');
    const rows = await this.deps.db
      .select()
      .from(agentTransfers)
      .where(eq(agentTransfers.id, trimmed));
    const row = rows.find((candidate) => candidate.id === trimmed);
    if (!row) throw new NotFoundError(`No transfer with id ${trimmed}. It may have expired.`);
    return row;
  }

  private async requireQuota(incoming: number, limits: TransferLimits): Promise<void> {
    const used = (await this.holdingRows()).reduce(
      (sum, row) => sum + Number(row.sizeBytes ?? 0),
      0,
    );
    if (used + incoming <= limits.quota_bytes) return;
    throw new ConflictError(
      `The fleet transfer pool is full: ${formatBytes(used)} of ${formatBytes(limits.quota_bytes)} in use and this adds ${formatBytes(incoming)}. Shorten the TTL, delete a transfer you no longer need, or ask an operator to raise the quota.`,
    );
  }

  private absolutePath(row: AgentTransfer): string {
    return join(this.deps.dataRoot, row.storagePath);
  }

  private async unlink(row: AgentTransfer): Promise<void> {
    await rm(this.absolutePath(row), { force: true });
  }

  private async hashFile(absolute: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absolute);
      stream.on('data', (part) => hash.update(part));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    return hash.digest('hex');
  }

  private async readSlice(row: AgentTransfer, offset: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    const handle = await open(this.absolutePath(row), 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private async bumpDownloadCount(id: string): Promise<void> {
    const rows = await this.deps.db
      .select()
      .from(agentTransfers)
      .where(eq(agentTransfers.id, id));
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return;
    await this.deps.db
      .update(agentTransfers)
      .set({ downloadCount: Number(row.downloadCount ?? 0) + 1, updatedAt: this.now() })
      .where(eq(agentTransfers.id, id));
  }

  private async recordEvent(
    transferId: string,
    action: string,
    actor: TransferActor,
    detail: string | null,
  ): Promise<void> {
    await this.deps.db.insert(agentTransferEvents).values({
      id: randomUUID(),
      transferId,
      action,
      actorKind: actor.kind,
      actorLabel: actor.label ?? null,
      sourceHostId: actor.kind === 'agent' ? (actor.hostId ?? null) : null,
      detail,
      createdAt: this.now(),
    });
  }

  private view(row: AgentTransfer): TransferView {
    const requested = row.requestedTtlSeconds == null ? null : Number(row.requestedTtlSeconds);
    const granted = Math.round(
      (new Date(row.expiresAt).getTime() - new Date(row.createdAt).getTime()) / 1000,
    );
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      mime_type: row.mimeType ?? null,
      size_bytes: Number(row.sizeBytes ?? 0),
      content_sha256: row.contentSha256 ?? null,
      status: row.status,
      source_host_id: row.sourceHostId ?? null,
      uploaded_by: row.uploadedBy ?? null,
      uploaded_from: row.uploadedFrom ?? null,
      requested_ttl_seconds: requested,
      ttl_clamped:
        requested !== null && Number.isFinite(granted) && Math.abs(requested - granted) > 1,
      download_count: Number(row.downloadCount ?? 0),
      expires_at: row.expiresAt,
      sealed_at: row.sealedAt ?? null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}
