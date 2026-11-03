import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CHAT_LIMITS, decodeAttachmentChunk } from '../../../src/services/agent-chat/contracts.js';
import { ChatAttachments } from '../../../src/services/agent-chat/attachments.js';
import type { Database } from '../../../src/db/client.js';
import type { Keyring } from '../../../src/security/keyring.js';

vi.mock('../../../src/services/workflow-run-group.js', async (original) => ({
  ...await original<typeof import('../../../src/services/workflow-run-group.js')>(),
  assertWorkflowAttachmentWrite: vi.fn(),
}));

describe('attachment chunk decoding', () => {
  it('accepts and reassembles a 9,586,521-byte binary file in uploader-sized chunks', () => {
    const source = Buffer.alloc(9_586_521);
    for (let i = 0; i < source.length; i++) source[i] = i % 251;
    const decoded: Buffer[] = [];
    for (let offset = 0; offset < source.length; offset += CHAT_LIMITS.max_chunk_bytes) {
      const chunk = source.subarray(offset, offset + CHAT_LIMITS.max_chunk_bytes);
      decoded.push(decodeAttachmentChunk(chunk.toString('base64')));
    }
    expect(Buffer.concat(decoded).equals(source)).toBe(true);
  });

  it.each(['Zg==', 'Zm8=', 'Zm9v', '/+7d'])('accepts valid padding and binary data: %s', (encoded) => {
    expect(decodeAttachmentChunk(encoded)).toEqual(Buffer.from(encoded, 'base64'));
  });

  it.each(['', 'Zg', 'Zg=', 'Z===', '====', '=AAA', 'AA=A', 'AAAA=', 'AA==AAAA', 'AA-_', 'AA==\n', 'AA =='])('rejects malformed or empty input: %j', (encoded) => {
    expect(() => decodeAttachmentChunk(encoded)).toThrow(/Invalid/);
  });

  it('rejects a decoded chunk beyond the advertised limit', () => {
    const encoded = Buffer.alloc(CHAT_LIMITS.max_chunk_bytes + 1).toString('base64');
    expect(() => decodeAttachmentChunk(encoded)).toThrow('Invalid upload chunk size');
  });

  it('writes all uploader-sized chunks and accepts exact retries without duplicating bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attachment-chunks-'));
    const session = randomUUID(), id = randomUUID(), owner = `agent:${session}`;
    const row = { owner, sizeBytes: 9_586_521, uploadedBytes: 0, status: 'uploading' };
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [row] }) }) }),
      update: () => ({ set: (value: object) => ({ where: async () => Object.assign(row, value) }) }),
    };
    const db = { transaction: async (fn: (handle: typeof tx) => unknown) => fn(tx) } as unknown as Database;
    const files = new ChatAttachments(db, {} as Keyring, root);
    vi.spyOn(files, 'conversationKey').mockResolvedValue(session);
    vi.spyOn(files, 'info').mockImplementation(async () => ({
      id, name: 'synthetic.zip', mime_type: 'application/zip', size_bytes: row.sizeBytes,
      uploaded_bytes: row.uploadedBytes, sha256: null, status: row.status, processing: null,
    }));
    const source = Buffer.alloc(row.sizeBytes, 0xa5);
    try {
      await mkdir(files.directory(id), { recursive: true });
      for (let offset = 0; offset < source.length; offset += CHAT_LIMITS.max_chunk_bytes) {
        const encoded = source.subarray(offset, offset + CHAT_LIMITS.max_chunk_bytes).toString('base64');
        await files.put(session, owner, id, offset, encoded);
        await files.put(session, owner, id, offset, encoded);
      }
      expect(row.uploadedBytes).toBe(source.length);
      expect((await readFile(files.path(id))).equals(source)).toBe(true);
      await expect(files.put(session, owner, id, 0, Buffer.from('wrong').toString('base64')))
        .rejects.toThrow('Upload retry bytes differ');
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
});
