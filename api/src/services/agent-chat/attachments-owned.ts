import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentChatAttachments } from '../../db/schema.js';
import { requireOwnerRuntime, mutateOwnerState } from '../../control-plane/state/runtime.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import { decrypt, encrypt } from '../../security/secret-box.js';
import type { Keyring } from '../../security/keyring.js';
import { nowIso } from '../../util/timestamp.js';
import { ownedWorkflowRunGroup } from '../workflow-run-group.js';
import { attachmentCreateSchema, CHAT_LIMITS } from './contracts.js';
import type { ChatAttachments } from './attachments.js';
import type { EffectHandler } from '../../control-plane/outbox.js';

export function attachmentConversation(state: OwnerStateSnapshot, id: string) {
  return state.table('hostDaemonPortalBindings').get(id)?.daemonSessionId ?? id;
}
export function assertAttachmentConversation(state: OwnerStateSnapshot, id: string) {
  if (
    !state.sessions.has(id) &&
    !state.table('hostDaemonSessions').has(id) &&
    !state.table('agentBusGroups').has(id) &&
    !state.table('agentBusConferences').has(id) &&
    !state.table('agentScopes').has(id)
  )
    throw new NotFoundError('Conversation not found');
  return state.sessions.get(id);
}
function authority(state: OwnerStateSnapshot, id: string, owner: string) {
  assertAttachmentConversation(state, id);
  const managed = ownedWorkflowRunGroup(state, id);
  if (!managed) return;
  if (managed.closed)
    throw new ConflictError('Workflow run communication is closed', 'workflow_group_closed');
  if (owner.startsWith('room:admin:')) return;
  if (!owner.startsWith('room:agent:'))
    throw new ForbiddenError('Workflow uploads require room access', 'workflow_member_required');
  const addressId = owner.slice('room:agent:'.length),
    member = managed.members.find((m) => m.agentAddressId === addressId && m.status === 'active');
  const session = member ? state.sessions.get(member.sessionId) : undefined,
    address = state.addresses.get(addressId);
  if (
    !session ||
    session.endedAt ||
    session.bindingGeneration !== member?.bindingGeneration ||
    session.agentBusAddressId !== addressId ||
    !address ||
    address.currentSessionId !== session.id ||
    address.bindingGeneration !== member?.bindingGeneration
  )
    throw new ForbiddenError('Active workflow run membership required', 'workflow_member_required');
}

/** File bytes are durable before their metadata is committed. Retries compare
 * existing bytes, so a crash in either half cannot append the chunk twice. */
export class OwnedChatAttachments {
  readonly runtime;
  constructor(
    private db: Database,
    private keyring: Keyring,
    private files: ChatAttachments,
  ) {
    this.runtime = requireOwnerRuntime(db);
  }
  private identity(sessionId: string, owner: string) {
    const id = attachmentConversation(this.runtime.state.snapshot(), sessionId);
    return { id, owner: owner.startsWith('agent:') ? `agent:${id}` : owner };
  }
  private async metadata(id: string) {
    const [row] = await this.db
      .select({ metadata: agentChatAttachments.metadataEnc })
      .from(agentChatAttachments)
      .where(eq(agentChatAttachments.id, id));
    if (!row) throw new NotFoundError('Attachment not found');
    return JSON.parse(decrypt(row.metadata, this.keyring)) as {
      name: string;
      mime_type: string;
      expected_sha256: string | null;
    };
  }
  async create(sessionId: string, owner: string, input: unknown) {
    const identity = this.identity(sessionId, owner),
      body = attachmentCreateSchema.parse(input),
      now = nowIso();
    if (body.size_bytes > this.files.limits().max_file_bytes)
      throw new ValidationError('File exceeds attachment limit');
    const meta = { name: body.name, mime_type: body.mime_type, expected_sha256: body.sha256 ?? null };
    await mutateOwnerState(this.runtime, {
      kind: 'attachment.create',
      payload: { session: identity.id, owner: identity.owner, ...body },
      authorize: (s) => authority(s, identity.id, identity.owner),
      prepare: async (ctx) => {
        const old = ctx.snapshot.table('agentChatAttachments').get(body.id);
        if (old) {
          if (
            old.sessionId !== identity.id ||
            old.owner !== identity.owner ||
            old.sizeBytes !== body.size_bytes ||
            JSON.stringify(await this.metadata(body.id)) !== JSON.stringify(meta)
          )
            throw new ConflictError('Upload ID already used');
          return null;
        }
        const pending = ctx.snapshot
          .table('agentChatAttachments')
          .by('sessionId', identity.id)
          .filter((row) => row.owner === identity.owner && ['uploading', 'ready'].includes(row.status));
        if (
          pending.length >= CHAT_LIMITS.max_attachments ||
          pending.reduce((n, r) => n + r.sizeBytes, 0) + body.size_bytes > this.files.limits().max_total_bytes
        )
          throw new ValidationError('Too many pending attachments');
        const row = {
          id: body.id,
          sessionId: identity.id,
          owner: identity.owner,
          metadataEnc: encrypt(JSON.stringify(meta), this.keyring),
          sizeBytes: body.size_bytes,
          uploadedBytes: 0,
          sha256: null,
          status: 'uploading',
          createdAt: now,
          updatedAt: now,
        };
        ctx.draft.upsert('agentChatAttachments', row);
        ctx.write((tx) => tx.insert(agentChatAttachments).values(row));
        return null;
      },
    });
    return this.files.info(identity.id, body.id);
  }
  async put(sessionId: string, owner: string, id: string, offset: number, encoded: string) {
    const identity = this.identity(sessionId, owner);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      throw new ValidationError('Invalid upload chunk');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > CHAT_LIMITS.max_chunk_bytes)
      throw new ValidationError('Invalid upload chunk size');
    await mutateOwnerState(this.runtime, {
      kind: 'attachment.put',
      payload: {
        session: identity.id,
        owner: identity.owner,
        id,
        offset,
        size: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
      },
      authorize: (s) => authority(s, identity.id, identity.owner),
      prepare: async (ctx) => {
        const row = ctx.snapshot.table('agentChatAttachments').get(id);
        if (!row || row.sessionId !== identity.id || row.owner !== identity.owner || row.status === 'retired')
          throw new NotFoundError('Upload not found');
        if (offset + bytes.length > row.sizeBytes)
          throw new ValidationError('Chunk exceeds declared file size');
        await mkdir(this.files.directory(id), { recursive: true, mode: 0o700 });
        const file = await open(this.files.path(id), 'a+', 0o600);
        try {
          const size = (await file.stat()).size;
          if (offset < size) {
            const present = Math.min(bytes.length, size - offset),
              read = Buffer.alloc(present);
            const result = await file.read(read, 0, present, offset);
            if (result.bytesRead !== present || !read.equals(bytes.subarray(0, present)))
              throw new ConflictError('Upload retry bytes differ');
            if (present < bytes.length) {
              if (row.status !== 'uploading' || offset !== row.uploadedBytes)
                throw new ConflictError('Upload retry is incomplete');
              await file.writeFile(bytes.subarray(present));
            }
          } else {
            if (row.status !== 'uploading' || offset !== size)
              throw new ConflictError('Upload offset differs', 'attachment_offset_conflict', {
                offset: size,
              });
            await file.writeFile(bytes);
          }
          await file.sync();
          const uploadedBytes = (await file.stat()).size;
          if (uploadedBytes !== row.uploadedBytes)
            stageUpdate(ctx, 'agentChatAttachments', id, { uploadedBytes, updatedAt: nowIso() });
        } finally {
          await file.close();
        }
        // fsync the new directory entry as well as bytes before acknowledging
        // uploadedBytes; a machine crash must not lose an acknowledged file.
        const directory = await open(this.files.directory(id), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return null;
      },
    });
    return this.files.info(identity.id, id);
  }
  async seal(sessionId: string, owner: string, id: string) {
    const identity = this.identity(sessionId, owner);
    await mutateOwnerState(this.runtime, {
      kind: 'attachment.seal',
      payload: { session: identity.id, owner: identity.owner, id },
      authorize: (s) => authority(s, identity.id, identity.owner),
      prepare: async (ctx) => {
        const row = ctx.snapshot.table('agentChatAttachments').get(id);
        if (!row || row.sessionId !== identity.id || row.owner !== identity.owner || row.status === 'retired')
          throw new NotFoundError('Upload not found');
        if (row.status !== 'uploading') return null;
        if ((await stat(this.files.path(id))).size !== row.sizeBytes)
          throw new ConflictError('Upload is incomplete');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(this.files.path(id))) hash.update(chunk);
        const digest = hash.digest('hex'),
          meta = await this.metadata(id);
        if (meta.expected_sha256 && meta.expected_sha256 !== digest)
          throw new ConflictError('Attachment checksum differs');
        const now = nowIso();
        stageUpdate(ctx, 'agentChatAttachments', id, { status: 'ready', sha256: digest, updatedAt: now });
        if (/^(audio|video)\//.test(meta.mime_type))
          ctx.effect({
            id: randomUUID(),
            kind: 'attachment.media_prepare',
            target: id,
            availableAt: now,
            payload: {
              id,
              sha256: digest,
              mime_type: meta.mime_type,
              max_seconds: CHAT_LIMITS.max_media_seconds,
            },
          });
        return null;
      },
    });
    return this.files.info(identity.id, id);
  }
  async discard(sessionId: string, owner: string, id: string) {
    const identity = this.identity(sessionId, owner);
    await mutateOwnerState(this.runtime, {
      kind: 'attachment.discard',
      payload: { session: identity.id, owner: identity.owner, id },
      authorize: (s) => authority(s, identity.id, identity.owner),
      prepare(ctx) {
        const row = ctx.snapshot.table('agentChatAttachments').get(id);
        if (!row || row.sessionId !== identity.id || row.owner !== identity.owner)
          throw new NotFoundError('Upload not found');
        if (row.status === 'linked') throw new ConflictError('Attachment belongs to a sent message');
        // The retention worker performs idempotent deletion only after retirement.
        if (row.status !== 'retired')
          stageUpdate(ctx, 'agentChatAttachments', id, { status: 'retired', updatedAt: nowIso() });
        return null;
      },
    });
    return { deleted: true };
  }
}

/** Stable attachment id plus digest makes job publication safe after lost ACK. */
export function mediaPrepareEffect(db: Database, files: ChatAttachments): EffectHandler {
  return async ({ target, payload }) => {
    const owner = requireOwnerRuntime(db),
      row = owner.state.snapshot().table('agentChatAttachments').get(target);
    if (!row || row.status === 'retired') return { status: 'delivered' };
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      payload.id !== target ||
      payload.sha256 !== row.sha256 ||
      !['ready', 'linked'].includes(row.status)
    )
      return { status: 'uncertain' };
    const directory = files.directory(target),
      body = JSON.stringify(payload),
      destination = join(directory, 'request.json');
    try {
      if ((await readFile(destination, 'utf8')) === body) return { status: 'delivered' };
      return { status: 'uncertain' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const tmp = join(directory, 'request.tmp'),
      file = await open(tmp, 'w', 0o600);
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, destination);
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return { status: 'delivered' };
  };
}
