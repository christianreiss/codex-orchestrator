import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  agentChatAttachments, agentBusGroups, agentBusConferences, agentScopes,
  agentSessions,
  hostDaemonPortalBindings,
  hostDaemonSessions,
  type AgentSession,
} from '../../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import { decrypt, encrypt } from '../../security/secret-box.js';
import type { Keyring } from '../../security/keyring.js';
import { nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import { attachmentCreateSchema, CHAT_LIMITS, type ChatMetadata } from './contracts.js';

type ChatDb = Pick<Database, 'select' | 'update' | 'insert'>;
export class ChatAttachments {
  constructor(
    private db: Database,
    private keyring: Keyring,
    private root: string,
  ) {}
  limits() {
    return {
      ...CHAT_LIMITS,
      max_file_bytes: this.setting('AGENT_CHAT_MAX_FILE_BYTES', CHAT_LIMITS.max_file_bytes),
      max_total_bytes: this.setting('AGENT_CHAT_MAX_TOTAL_BYTES', CHAT_LIMITS.max_total_bytes),
    };
  }
  private setting(key: string, fallback: number) {
    const n = Number(process.env[key]);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  }
  directory(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError('Invalid attachment ID');
    return join(this.root, 'agent-chat', id);
  }
  path(id: string) {
    return join(this.directory(id), 'original');
  }
  async conversationKey(id: string, db: ChatDb = this.db) {
    const [binding] = await db
      .select()
      .from(hostDaemonPortalBindings)
      .where(eq(hostDaemonPortalBindings.portalSessionId, id))
      .limit(1);
    return binding?.daemonSessionId ?? id;
  }
  private async session(id: string, db: ChatDb = this.db) {
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
    if (!session) {
      const [remote] = await db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, id))
        .limit(1);
      if (!remote) {
        const rooms = await Promise.all([
          this.db.select({id: agentBusGroups.id}).from(agentBusGroups).where(eq(agentBusGroups.id, id)),
          this.db.select({id: agentBusConferences.id}).from(agentBusConferences).where(eq(agentBusConferences.id, id)),
          this.db.select({id: agentScopes.id}).from(agentScopes).where(eq(agentScopes.id, id)),
        ]);
        if (!rooms.some(rows => rows.length)) throw new NotFoundError('Conversation not found');
      }
    }
    return session;
  }
  async create(sessionId: string, owner: string, input: unknown) {
    sessionId = await this.conversationKey(sessionId);
    if (owner.startsWith('agent:')) owner = `agent:${sessionId}`;
    const body = attachmentCreateSchema.parse(input);
    if (body.size_bytes > this.limits().max_file_bytes)
      throw new ValidationError('File exceeds attachment limit');
    await this.session(sessionId);
    const now = nowIso();
    await this.db.transaction(async (tx) => {
      await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).for('update');
      await tx.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.id, sessionId)).for('update');
      await tx.select().from(agentBusGroups).where(eq(agentBusGroups.id, sessionId)).for('update');
      await tx.select().from(agentBusConferences).where(eq(agentBusConferences.id, sessionId)).for('update');
      await tx.select().from(agentScopes).where(eq(agentScopes.id, sessionId)).for('update');
      const [old] = await tx
        .select()
        .from(agentChatAttachments)
        .where(eq(agentChatAttachments.id, body.id))
        .for('update');
      const meta = { name: body.name, mime_type: body.mime_type, expected_sha256: body.sha256 ?? null };
      if (old) {
        if (
          old.sessionId !== sessionId ||
          old.owner !== owner ||
          old.sizeBytes !== body.size_bytes ||
          decrypt(old.metadataEnc, this.keyring) !== JSON.stringify(meta)
        )
          throw new ConflictError('Upload ID already used');
        return;
      }
      const pending = await tx
        .select({ size: agentChatAttachments.sizeBytes })
        .from(agentChatAttachments)
        .where(
          and(
            eq(agentChatAttachments.sessionId, sessionId),
            eq(agentChatAttachments.owner, owner),
            inArray(agentChatAttachments.status, ['uploading', 'ready']),
          ),
        );
      if (
        pending.length >= CHAT_LIMITS.max_attachments ||
        pending.reduce((s, r) => s + r.size, 0) + body.size_bytes > this.limits().max_total_bytes
      )
        throw new ValidationError('Too many pending attachments');
      await mkdir(this.directory(body.id), { recursive: true, mode: 0o700 });
      await tx
        .insert(agentChatAttachments)
        .values({
          id: body.id,
          sessionId,
          owner,
          metadataEnc: encrypt(JSON.stringify(meta), this.keyring),
          sizeBytes: body.size_bytes,
          createdAt: now,
          updatedAt: now,
        });
    });
    return this.info(sessionId, body.id);
  }
  async put(sessionId: string, owner: string, id: string, offset: number, encoded: string) {
    sessionId = await this.conversationKey(sessionId);
    if (owner.startsWith('agent:')) owner = `agent:${sessionId}`;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw new ValidationError('Invalid base64');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > CHAT_LIMITS.max_chunk_bytes)
      throw new ValidationError('Invalid upload chunk size');
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(agentChatAttachments)
        .where(and(eq(agentChatAttachments.id, id), eq(agentChatAttachments.sessionId, sessionId)))
        .for('update');
      if (!row || row.owner !== owner) throw new NotFoundError('Upload not found');
      if (offset + bytes.length > row.sizeBytes)
        throw new ValidationError('Chunk exceeds declared file size');
      const file = await open(this.path(id), 'a+', 0o600);
      try {
        const size = (await file.stat()).size;
        if (offset < size) {
          const present = Math.min(bytes.length, size - offset);
          const read = Buffer.alloc(present);
          const result = await file.read(read, 0, present, offset);
          if (result.bytesRead !== present || !read.equals(bytes.subarray(0, present)))
            throw new ConflictError('Upload retry bytes differ');
          if (present < bytes.length) {
            if (row.status !== 'uploading' || offset !== row.uploadedBytes)
              throw new ConflictError('Upload retry is incomplete');
            // A process may crash after a partial fs write but before DB commit.
            await file.writeFile(bytes.subarray(present));
            await file.sync();
          }
        } else {
          if (row.status !== 'uploading' || offset !== size)
            throw new ConflictError('Upload offset differs', 'attachment_offset_conflict', { offset: size });
          await file.writeFile(bytes);
          await file.sync();
        }
        await tx
          .update(agentChatAttachments)
          .set({ uploadedBytes: (await file.stat()).size, updatedAt: nowIso() })
          .where(eq(agentChatAttachments.id, id));
      } finally {
        await file.close();
      }
    });
    return this.info(sessionId, id);
  }
  async seal(sessionId: string, owner: string, id: string) {
    sessionId = await this.conversationKey(sessionId);
    if (owner.startsWith('agent:')) owner = `agent:${sessionId}`;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(agentChatAttachments)
        .where(and(eq(agentChatAttachments.id, id), eq(agentChatAttachments.sessionId, sessionId)))
        .for('update');
      if (!row || row.owner !== owner) throw new NotFoundError('Upload not found');
      if (row.status !== 'uploading') return;
      if ((await stat(this.path(id))).size !== row.sizeBytes) throw new ConflictError('Upload is incomplete');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(this.path(id))) hash.update(chunk);
      const digest = hash.digest('hex');
      const metadata = JSON.parse(decrypt(row.metadataEnc, this.keyring)) as {
        expected_sha256?: string;
        mime_type: string;
      };
      if (metadata.expected_sha256 && digest !== metadata.expected_sha256)
        throw new ConflictError('Attachment checksum differs');
      await tx
        .update(agentChatAttachments)
        .set({ status: 'ready', sha256: digest, updatedAt: nowIso() })
        .where(eq(agentChatAttachments.id, id));
    });
    const info = await this.info(sessionId, id);
    if (/^(audio|video)\//.test(String(info.mime_type))) {
      // Atomic job publication; the worker sees only fully sealed originals.
      const dir = this.directory(id);
      try {
        await stat(join(dir, 'request.json'));
      } catch {
        await writeFile(
          join(dir, 'request.tmp'),
          JSON.stringify({ id, mime_type: info.mime_type, max_seconds: CHAT_LIMITS.max_media_seconds }),
          { mode: 0o600 },
        );
        const { rename } = await import('node:fs/promises');
        await rename(join(dir, 'request.tmp'), join(dir, 'request.json'));
      }
    }
    wsPublisher.publish('agent_portal.sessions.changed', { session_id: sessionId });
    return this.info(sessionId, id);
  }
  async assertReadableDraft(sessionId: string, id: string, owner: string) {
    const [row] = await this.db.select().from(agentChatAttachments).where(and(eq(agentChatAttachments.id,id),eq(agentChatAttachments.sessionId,sessionId)));
    if (!row || (row.status !== 'linked' && row.owner !== owner)) throw new NotFoundError('Attachment not found');
  }
  async info(sessionId: string, id: string) {
    sessionId = await this.conversationKey(sessionId);
    await this.session(sessionId);
    const [row] = await this.db
      .select()
      .from(agentChatAttachments)
      .where(and(eq(agentChatAttachments.id, id), eq(agentChatAttachments.sessionId, sessionId)))
      .limit(1);
    if (!row) throw new NotFoundError('Attachment not found');
    const meta = JSON.parse(decrypt(row.metadataEnc, this.keyring)) as Record<string, unknown>;
    let processing: unknown =
      /^(audio|video)\//.test(String(meta.mime_type)) && row.status !== 'uploading'
        ? { state: 'queued' }
        : null;
    try {
      processing = JSON.parse(await readFile(join(this.directory(id), 'processing.json'), 'utf8'));
    } catch {
      /* Worker has not published a result yet. */
    }
    return {
      id: row.id,
      name: meta.name,
      mime_type: meta.mime_type,
      size_bytes: row.sizeBytes,
      uploaded_bytes: row.uploadedBytes,
      sha256: row.sha256,
      status: row.status,
      processing,
    };
  }
  async download(sessionId: string, id: string, variant = 'original') {
    const info = await this.info(sessionId, id);
    if (!['ready', 'linked'].includes(String(info.status)))
      throw new ConflictError('Attachment is not ready');
    if (!/^(original|transcript\.json|frame-\d{2}\.jpg)$/.test(variant))
      throw new ValidationError('Invalid attachment variant');
    const path = join(this.directory(id), variant);
    try {
      await stat(path);
    } catch {
      throw new NotFoundError('Attachment output not available');
    }
    return {
      ...info,
      path,
      mime_type:
        variant === 'original'
          ? String(info.mime_type)
          : variant.endsWith('.jpg')
            ? 'image/jpeg'
            : 'application/json',
    };
  }
  async discard(sessionId: string, owner: string, id: string) {
    sessionId = await this.conversationKey(sessionId);
    if (owner.startsWith('agent:')) owner = `agent:${sessionId}`;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(agentChatAttachments)
        .where(and(eq(agentChatAttachments.id, id), eq(agentChatAttachments.sessionId, sessionId)))
        .for('update');
      if (!row || row.owner !== owner) throw new NotFoundError('Upload not found');
      if (row.status === 'linked') throw new ConflictError('Attachment belongs to a sent message');
      await rm(this.directory(id), { recursive: true, force: true });
      await tx.delete(agentChatAttachments).where(eq(agentChatAttachments.id, id));
    });
    return { deleted: true };
  }
  async link(db: ChatDb, sessionId: string, metadata: ChatMetadata, owner?: string) {
    const originalSessionId = sessionId;
    sessionId = await this.conversationKey(sessionId, db);
    if (owner?.startsWith('agent:')) owner = `agent:${sessionId}`;
    const ids = [...new Set(metadata.attachments ?? [])];
    if (metadata.reply_to) {
      const { agentEvents } = await import('../../db/schema.js');
      const bindings = await db
        .select({ id: hostDaemonPortalBindings.portalSessionId })
        .from(hostDaemonPortalBindings)
        .where(eq(hostDaemonPortalBindings.daemonSessionId, sessionId));
      const conversationIds = [originalSessionId, ...bindings.map((b) => b.id)];
      const [event] = await db
        .select({ id: agentEvents.id })
        .from(agentEvents)
        .where(and(inArray(agentEvents.sessionId, conversationIds), eq(agentEvents.id, metadata.reply_to)))
        .limit(1);
      if (!event) throw new ValidationError('Reply target is outside this conversation');
    }
    if (!ids.length) return;
    const rows = await db
      .select()
      .from(agentChatAttachments)
      .where(and(eq(agentChatAttachments.sessionId, sessionId), inArray(agentChatAttachments.id, ids)))
      .for('update');
    if (
      rows.length !== ids.length ||
      rows.some((r) => !['ready', 'linked'].includes(r.status) || (owner && r.owner !== owner))
    )
      throw new ForbiddenError('Attachment is unavailable or belongs to another sender');
    if (rows.reduce((s, r) => s + r.sizeBytes, 0) > this.limits().max_total_bytes)
      throw new ValidationError('Attachments exceed total limit');
    await db
      .update(agentChatAttachments)
      .set({ status: 'linked' })
      .where(inArray(agentChatAttachments.id, ids));
  }
  async purge() {
    const cutoff = new Date(Date.now() - 86400_000).toISOString();
    const rows = await this.db
      .select({ row: agentChatAttachments, session: agentSessions.id })
      .from(agentChatAttachments)
      .leftJoin(agentSessions, eq(agentSessions.id, agentChatAttachments.sessionId))
      .leftJoin(hostDaemonSessions, eq(hostDaemonSessions.id, agentChatAttachments.sessionId))
      .where(
        or(
          and(
            isNull(agentSessions.id),
            isNull(hostDaemonSessions.id),
            sql`NOT EXISTS (SELECT 1 FROM agent_bus_groups g WHERE BINARY g.id = BINARY ${agentChatAttachments.sessionId})`,
            sql`NOT EXISTS (SELECT 1 FROM agent_bus_conferences c WHERE BINARY c.id = BINARY ${agentChatAttachments.sessionId})`,
            sql`NOT EXISTS (SELECT 1 FROM agent_scopes s WHERE BINARY s.id = BINARY ${agentChatAttachments.sessionId})`,
            sql`NOT EXISTS (SELECT 1 FROM host_daemon_portal_bindings b INNER JOIN agent_sessions s ON s.id = b.portal_session_id WHERE b.daemon_session_id = ${agentChatAttachments.sessionId})`,
          ),
          and(
            inArray(agentChatAttachments.status, ['uploading', 'ready']),
            lt(agentChatAttachments.updatedAt, cutoff),
          ),
        ),
      )
      .limit(100);
    for (const { row } of rows) {
      await rm(this.directory(row.id), { recursive: true, force: true });
      await this.db.delete(agentChatAttachments).where(eq(agentChatAttachments.id, row.id));
    }
    return rows.length;
  }
}
export function chatAttachmentOwner(session: AgentSession) {
  return `agent:${session.id}`;
}
