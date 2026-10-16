import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentTransfers, type AgentTransfer, type Host } from '../../db/schema.js';
import { ConflictError, ForbiddenError, ValidationError } from '../../http/errors.js';
import { wsPublisher } from '../../ws/publisher.js';
import {
  clampTtlSeconds,
  normalizeTransferName,
  type TransferActor,
  type TransferLimits,
  type TransferView,
} from '../agent-transfers.js';

/** Request size, never a file-size limit. Leaves room below the normal proxy body limit. */
export const BINARY_CHUNK_BYTES = 16 * 1024 * 1024;

export interface BinaryTransferInput {
  id: string;
  name: string;
  size_bytes: number;
  content_sha256: string;
  ttl_seconds: number;
  username?: string;
  worktree_path?: string;
  description?: string;
  mime_type?: string;
}

interface BinaryCore {
  db: Database;
  dataRoot: string;
  now: () => string;
  transaction: <T>(operation: (db: Database) => Promise<T>) => Promise<T>;
  limits: () => Promise<TransferLimits>;
  requireRow: (id: string, db?: Database) => Promise<AgentTransfer>;
  view: (row: AgentTransfer) => TransferView;
  quota: (incoming: number, limits: TransferLimits, db: Database) => Promise<void>;
  event: (
    id: string,
    action: string,
    actor: TransferActor,
    detail: string | null,
    db?: Database,
  ) => Promise<void>;
  hash: (path: string) => Promise<string>;
}

export class BinaryTransfers {
  constructor(private readonly core: BinaryCore) {}

  private path(row: AgentTransfer) {
    return join(this.core.dataRoot, row.storagePath);
  }
  private owner(row: AgentTransfer, host: Host) {
    if (row.sourceHostId !== host.id)
      throw new ForbiddenError('Only the uploading host may continue or seal this transfer');
    if (row.expectedSizeBytes == null) throw new ConflictError('This is a legacy MCP upload');
    if (row.expiresAt <= this.core.now() || !['uploading', 'live'].includes(row.status)) {
      throw new ConflictError(`Transfer ${row.id} has expired or was deleted`);
    }
  }

  async create(input: BinaryTransferInput, host: Host): Promise<TransferView> {
    const name = normalizeTransferName(input.name);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.id))
      throw new ValidationError('id must be a UUID v4');
    if (!Number.isSafeInteger(input.size_bytes) || input.size_bytes < 0)
      throw new ValidationError('size_bytes must be a nonnegative safe integer');
    if (!/^[0-9a-f]{64}$/.test(input.content_sha256))
      throw new ValidationError('content_sha256 must be a lowercase SHA-256');
    if (!Number.isSafeInteger(input.ttl_seconds) || input.ttl_seconds < 0 || input.ttl_seconds > 0xffffffff)
      throw new ValidationError('ttl_seconds must be an unsigned integer');
    for (const [key, max] of [
      ['username', 255],
      ['worktree_path', 512],
      ['description', 2000],
      ['mime_type', 255],
    ] as const) {
      if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > max))
        throw new ValidationError(`Invalid ${key}`);
    }
    const result = await this.core.transaction(async (db) => {
      const existing = (await db.select().from(agentTransfers).where(eq(agentTransfers.id, input.id))).find(
        (r) => r.id === input.id,
      );
      if (existing) {
        this.owner(existing, host);
        if (
          existing.name !== name ||
          Number(existing.expectedSizeBytes) !== input.size_bytes ||
          existing.expectedSha256 !== input.content_sha256 ||
          existing.requestedTtlSeconds !== input.ttl_seconds
        ) {
          throw new ConflictError('This request ID already identifies a different upload');
        }
        return this.core.view(existing);
      }
      const limits = await this.core.limits();
      if (limits.max_file_bytes > 0 && input.size_bytes > limits.max_file_bytes)
        throw new ValidationError('Upload exceeds the configured per-file limit');
      await this.core.quota(input.size_bytes, limits, db);
      const { effective } = clampTtlSeconds(input.ttl_seconds, limits.max_ttl_seconds);
      const now = this.core.now();
      const row: AgentTransfer = {
        id: input.id,
        name,
        description: input.description ?? null,
        mimeType: input.mime_type ?? null,
        sizeBytes: 0,
        contentSha256: null,
        expectedSizeBytes: input.size_bytes,
        expectedSha256: input.content_sha256,
        storagePath: join('transfers', input.id.slice(0, 2), input.id),
        status: 'uploading',
        sourceHostId: host.id,
        uploadedBy: input.username ?? null,
        uploadedFrom: input.worktree_path ?? null,
        requestedTtlSeconds: input.ttl_seconds,
        downloadCount: 0,
        expiresAt: new Date(Date.parse(now) + effective * 1000).toISOString(),
        sealedAt: null,
        purgedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await mkdir(dirname(this.path(row)), { recursive: true });
      // A crashed create can leave an empty orphan. No other request can own
      // this UUID under the global write lock, so discard that orphan on retry.
      const handle = await open(this.path(row), 'w', 0o600);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await db.insert(agentTransfers).values(row);
      await this.core.event(
        row.id,
        'uploaded',
        { kind: 'agent', label: row.uploadedBy, hostId: host.id },
        `binary upload; ${input.size_bytes} bytes reserved`,
        db,
      );
      return this.core.view(row);
    });
    wsPublisher.publish('transfers.changed', { kind: 'created', id: input.id });
    return result;
  }

  async append(
    id: string,
    offset: number,
    length: number,
    source: AsyncIterable<Buffer>,
    host: Host,
  ): Promise<TransferView> {
    const initial = await this.core.requireRow(id);
    this.owner(initial, host);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset !== Number(initial.sizeBytes))
      throw new ConflictError(`Resume from ${initial.sizeBytes}`);
    if (!Number.isSafeInteger(length) || length <= 0 || length > BINARY_CHUNK_BYTES)
      throw new ValidationError(
        `Content-Length must be 1..${BINARY_CHUNK_BYTES}; larger files use successive requests`,
      );
    if (initial.status !== 'uploading' || offset + length > Number(initial.expectedSizeBytes))
      throw new ConflictError('Chunk exceeds declared size or upload is already sealed');
    const temporary = `${this.path(initial)}.${randomUUID()}.part`;
    const staged = await open(temporary, 'wx+', 0o600);
    let received = 0;
    try {
      // Receive outside ANY database transaction. Backpressure comes from each
      // awaited filesystem write. An aborted request never advances the offset.
      for await (const part of source) {
        if (received + part.length > length) throw new ValidationError('Body exceeds Content-Length');
        if (initial.expiresAt <= this.core.now()) throw new ConflictError('Upload expired');
        let written = 0;
        while (written < part.length) {
          const result = await staged.write(part, written, part.length - written, received + written);
          if (!result.bytesWritten) throw new Error('Transfer store write failed');
          written += result.bytesWritten;
        }
        received += part.length;
      }
      if (received !== length)
        throw new ValidationError('Incomplete binary body; resume from the last confirmed offset');
      const result = await this.core.transaction(async (db) => {
        const row = await this.core.requireRow(id, db);
        this.owner(row, host);
        if (row.status !== 'uploading' || Number(row.sizeBytes) !== offset)
          throw new ConflictError(`Resume from ${row.sizeBytes}`);
        const limits = await this.core.limits();
        if (limits.max_file_bytes > 0 && offset + length > limits.max_file_bytes)
          throw new ValidationError('Upload exceeds the configured per-file limit');
        // A quota reduced after reservation also applies to existing uploads.
        await this.core.quota(0, limits, db);
        const target = await open(this.path(row), 'r+');
        try {
          if ((await target.stat()).size < offset)
            throw new ConflictError('Stored file is shorter than its committed offset');
          await target.truncate(offset); // discard a killed writer's uncommitted tail
          const buffer = Buffer.allocUnsafe(256 * 1024);
          let copied = 0;
          while (copied < length) {
            const { bytesRead } = await staged.read(
              buffer,
              0,
              Math.min(buffer.length, length - copied),
              copied,
            );
            if (!bytesRead) throw new Error('Staged transfer is incomplete');
            let written = 0;
            while (written < bytesRead) {
              const result = await target.write(
                buffer,
                written,
                bytesRead - written,
                offset + copied + written,
              );
              if (!result.bytesWritten) throw new Error('Transfer store write failed');
              written += result.bytesWritten;
            }
            copied += bytesRead;
          }
          await target.sync(); // bytes durable BEFORE metadata commits
        } finally {
          await target.close();
        }
        const update = { sizeBytes: offset + length, updatedAt: this.core.now() };
        await db.update(agentTransfers).set(update).where(eq(agentTransfers.id, id));
        await this.core.event(
          id,
          'appended',
          { kind: 'agent', label: row.uploadedBy, hostId: host.id },
          `${length} binary bytes at offset ${offset}`,
          db,
        );
        return this.core.view({ ...row, ...update });
      });
      wsPublisher.publish('transfers.changed', { kind: 'appended', id });
      return result;
    } finally {
      await staged.close();
      await rm(temporary, { force: true });
    }
  }

  async seal(id: string, host: Host): Promise<TransferView> {
    const row = await this.core.requireRow(id);
    this.owner(row, host);
    if (row.status === 'live') return this.core.view(row);
    if (Number(row.sizeBytes) !== Number(row.expectedSizeBytes))
      throw new ConflictError(`Upload incomplete; resume from ${row.sizeBytes}`);
    // Full uploads cannot append further. Hash outside the transaction; the
    // final locked read fences deletion/expiry and checks the immutable size.
    const hash = await this.core.hash(this.path(row));
    if (hash !== row.expectedSha256)
      throw new ConflictError('SHA-256 mismatch; start a new transfer from the source file');
    return this.core.transaction(async (db) => {
      const current = await this.core.requireRow(id, db);
      this.owner(current, host);
      if (current.status === 'live') return this.core.view(current);
      if (current.sizeBytes !== row.sizeBytes) throw new ConflictError('Upload changed during verification');
      const now = this.core.now();
      const update = { contentSha256: hash, status: 'live', sealedAt: now, updatedAt: now };
      await db.update(agentTransfers).set(update).where(eq(agentTransfers.id, id));
      await this.core.event(
        id,
        'sealed',
        { kind: 'agent', label: row.uploadedBy, hostId: host.id },
        `SHA-256 ${hash}`,
        db,
      );
      wsPublisher.publish('transfers.changed', { kind: 'sealed', id });
      return this.core.view({ ...current, ...update });
    });
  }

  async download(id: string, offset: number, actor: TransferActor) {
    const row = await this.core.requireRow(id);
    if (row.status !== 'live' || row.expiresAt <= this.core.now())
      throw new ConflictError('Transfer is not available for download');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number(row.sizeBytes))
      throw new ValidationError('Invalid download offset');
    // Open before replying: unlinking an expired transfer cannot race a lazy
    // stream open. Already-open downloads may finish; new downloads are denied.
    const handle = await open(this.path(row), 'r');
    if ((await handle.stat()).size !== Number(row.sizeBytes)) {
      await handle.close();
      throw new ConflictError('Stored transfer size differs from metadata');
    }
    try {
      await this.core.event(id, 'downloaded', actor, `binary download from offset ${offset}`);
    } catch (error) {
      await handle.close();
      throw error;
    }
    const stream = handle.createReadStream({ start: offset, autoClose: true });
    const completed = async () => {
      await this.core.transaction(async (db) => {
        const current = await this.core.requireRow(id, db);
        await db
          .update(agentTransfers)
          .set({ downloadCount: Number(current.downloadCount) + 1 })
          .where(eq(agentTransfers.id, id));
      });
    };
    return { transfer: this.core.view(row), stream, completed };
  }
}
