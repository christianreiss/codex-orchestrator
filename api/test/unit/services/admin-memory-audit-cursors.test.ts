import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../src/http/errors.js';
import { resolveMemoryAuditContext } from '../../../src/services/admin-memory-audit.js';
import {
  decodeActivityPosition,
  decodeGraphPosition,
  decodeMemoryGraphCursor,
  encodeActivityPosition,
  encodeGraphPosition,
  sanitizeMemoryAuditDetails,
} from '../../../src/services/admin-memory-model.js';

const FINGERPRINT = 'abc123def4567890';
const OTHER_FINGERPRINT = '0987654321fedcba';

/** Mirrors the module-private opaque encoder so malformed cursors can be built by hand. */
function encodeOpaque(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function expectCursorRejection(run: () => unknown, label: string): void {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught, label).toBeInstanceOf(ValidationError);
  expect(caught, label).toMatchObject({ status: 422, param: 'cursor' });
}

describe('memory audit detail redaction', () => {
  it('rejects anything that is not a JSON object', () => {
    for (const value of [
      null,
      undefined,
      [],
      ['content'],
      42,
      true,
      '',
      'not json',
      '{oops',
      '[1,2]',
      'null',
    ]) {
      expect(sanitizeMemoryAuditDetails(value), JSON.stringify(value) ?? 'undefined').toBeNull();
    }
  });

  it('parses JSON string payloads before redacting them', () => {
    expect(sanitizeMemoryAuditDetails('{"content":"secret","content_length":6,"actor_id":3}')).toEqual({
      content_length: 6,
      actor_id: 3,
    });
  });

  it('strips body-bearing keys at every depth while keeping the metadata-only fields', () => {
    const sanitized = sanitizeMemoryAuditDetails({
      actor_id: 7,
      node_id: 'memory:project:41',
      memory_id: 'deploy.crane',
      body: 'secret body',
      content: 'secret content',
      preview: 'secret preview',
      metadata: { owner: 'secret ops' },
      old_content: 'secret previous',
      new_body: 'secret next',
      memory_preview: 'secret peek',
      entry_metadata: { hidden: 'secret flag' },
      content_length: 25,
      old_content_length: 20,
      tag_count: 2,
      content_sha256: 'a'.repeat(64),
      old_etag: 'etag-1',
      new_etag: 'etag-2',
      nested: {
        content: 'secret nested',
        preview: 'secret nested preview',
        content_length: 13,
        deeper: { metadata: { k: 'secret v' }, tag_count: 1 },
      },
      entries: [
        { body: 'secret in array', content_length: 12, tags: ['ops'] },
        { nested: { content: 'secret deep in array', old_etag: 'etag-3' } },
      ],
    });

    expect(sanitized).toEqual({
      actor_id: 7,
      node_id: 'memory:project:41',
      memory_id: 'deploy.crane',
      content_length: 25,
      old_content_length: 20,
      tag_count: 2,
      content_sha256: 'a'.repeat(64),
      old_etag: 'etag-1',
      new_etag: 'etag-2',
      nested: { content_length: 13, deeper: { tag_count: 1 } },
      entries: [{ content_length: 12, tags: ['ops'] }, { nested: { old_etag: 'etag-3' } }],
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/secret/);
  });

  it('ignores key casing when deciding what to drop', () => {
    expect(sanitizeMemoryAuditDetails({ Content: 'secret', Old_Body: 'secret', Tag_Count: 4 })).toEqual({
      Tag_Count: 4,
    });
  });
});

describe('memory graph offset cursor', () => {
  it('round-trips a non-negative offset for the matching fingerprint', () => {
    expect(
      decodeMemoryGraphCursor(encodeOpaque({ v: 1, fingerprint: FINGERPRINT, offset: 0 }), FINGERPRINT),
    ).toBe(0);
    expect(
      decodeMemoryGraphCursor(encodeOpaque({ v: 1, fingerprint: FINGERPRINT, offset: 40 }), FINGERPRINT),
    ).toBe(40);
  });

  it('rejects foreign fingerprints, wrong versions, malformed payloads and bad offsets', () => {
    const cursor = encodeOpaque({ v: 1, fingerprint: FINGERPRINT, offset: 40 });
    expectCursorRejection(() => decodeMemoryGraphCursor(cursor, OTHER_FINGERPRINT), 'fingerprint');
    expectCursorRejection(
      () =>
        decodeMemoryGraphCursor(encodeOpaque({ v: 2, fingerprint: FINGERPRINT, offset: 40 }), FINGERPRINT),
      'version',
    );

    for (const payload of [
      '@@@@',
      '',
      Buffer.from('not json', 'utf8').toString('base64url'),
      encodeOpaque([1, 2]),
    ]) {
      expectCursorRejection(() => decodeMemoryGraphCursor(payload, FINGERPRINT), `payload ${payload}`);
    }

    for (const offset of [-1, 1.5, '40', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expectCursorRejection(
        () => decodeMemoryGraphCursor(encodeOpaque({ v: 1, fingerprint: FINGERPRINT, offset }), FINGERPRINT),
        `offset ${String(offset)}`,
      );
    }
  });
});

describe('memory graph keyset cursor', () => {
  const position = { updatedAt: '2026-07-28T09:00:00Z', scope: 'shared' as const, recordId: 42 };

  it('round-trips a position as an opaque base64url token', () => {
    const cursor = encodeGraphPosition(position, FINGERPRINT);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeGraphPosition(cursor, FINGERPRINT)).toEqual(position);
  });

  it('rejects foreign fingerprints, wrong versions, malformed payloads and bad positions', () => {
    expectCursorRejection(
      () => decodeGraphPosition(encodeGraphPosition(position, FINGERPRINT), OTHER_FINGERPRINT),
      'fingerprint',
    );
    expectCursorRejection(
      () =>
        decodeGraphPosition(
          encodeActivityPosition({ createdAt: 'x', source: 'admin', numericId: 1 }, FINGERPRINT),
          FINGERPRINT,
        ),
      'version',
    );

    for (const payload of [
      '@@@@',
      '',
      Buffer.from('not json', 'utf8').toString('base64url'),
      encodeOpaque([1, 2]),
    ]) {
      expectCursorRejection(() => decodeGraphPosition(payload, FINGERPRINT), `payload ${payload}`);
    }

    const invalid: Record<string, unknown>[] = [
      { ...position, recordId: 0 },
      { ...position, recordId: -1 },
      { ...position, recordId: 1.5 },
      { ...position, recordId: Number.MAX_SAFE_INTEGER + 1 },
      { ...position, recordId: '42' },
      { ...position, scope: 'global' },
      { ...position, updatedAt: 42 },
      { scope: 'shared', recordId: 42 },
    ];
    for (const parts of invalid) {
      expectCursorRejection(
        () => decodeGraphPosition(encodeOpaque({ v: 2, fingerprint: FINGERPRINT, ...parts }), FINGERPRINT),
        JSON.stringify(parts),
      );
    }
  });
});

describe('memory activity cursor', () => {
  const position = { createdAt: '2026-07-28T09:00:00Z', source: 'admin', numericId: 91 };

  it('round-trips a position as an opaque base64url token', () => {
    const cursor = encodeActivityPosition(position, FINGERPRINT);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeActivityPosition(cursor, FINGERPRINT)).toEqual(position);
  });

  it('rejects foreign fingerprints, wrong versions, malformed payloads and bad positions', () => {
    expectCursorRejection(
      () => decodeActivityPosition(encodeActivityPosition(position, FINGERPRINT), OTHER_FINGERPRINT),
      'fingerprint',
    );
    expectCursorRejection(
      () =>
        decodeActivityPosition(
          encodeGraphPosition({ updatedAt: 'x', scope: 'shared', recordId: 1 }, FINGERPRINT),
          FINGERPRINT,
        ),
      'version',
    );

    for (const payload of [
      '@@@@',
      '',
      Buffer.from('not json', 'utf8').toString('base64url'),
      encodeOpaque([1, 2]),
    ]) {
      expectCursorRejection(() => decodeActivityPosition(payload, FINGERPRINT), `payload ${payload}`);
    }

    const invalid: Record<string, unknown>[] = [
      { ...position, numericId: 0 },
      { ...position, numericId: -1 },
      { ...position, numericId: 1.5 },
      { ...position, numericId: Number.MAX_SAFE_INTEGER + 1 },
      { ...position, source: 7 },
      { ...position, createdAt: null },
      { createdAt: '2026-07-28T09:00:00Z', source: 'admin' },
    ];
    for (const parts of invalid) {
      expectCursorRejection(
        () => decodeActivityPosition(encodeOpaque({ v: 1, fingerprint: FINGERPRINT, ...parts }), FINGERPRINT),
        JSON.stringify(parts),
      );
    }
  });
});

describe('memory audit context resolution', () => {
  const current = { key: 'deploy.crane', ownerHostId: 3, projectId: 7, projectSlug: 'orchestrator' };

  it('prefers the current row over the retained payload', () => {
    expect(
      resolveMemoryAuditContext(current, {
        memory_id: 'stale.key',
        host_id: 91,
        project_id: 92,
        project_slug: 'stale-project',
      }),
    ).toEqual({ key: 'deploy.crane', hostId: 3, projectId: 7, projectSlug: 'orchestrator' });
  });

  it('falls back to the retained payload for a deleted memory', () => {
    const payload = {
      memory_id: 'deploy.crane',
      host_id: 4,
      project_id: 9,
      project_slug: 'orchestrator',
      content: 'secret body',
    };

    expect(resolveMemoryAuditContext(null, payload)).toEqual({
      key: 'deploy.crane',
      hostId: 4,
      projectId: 9,
      projectSlug: 'orchestrator',
    });
    expect(resolveMemoryAuditContext(null, JSON.stringify(payload))).toEqual({
      key: 'deploy.crane',
      hostId: 4,
      projectId: 9,
      projectSlug: 'orchestrator',
    });
  });

  it('fills the gaps of a partially scoped current row', () => {
    expect(
      resolveMemoryAuditContext(
        { key: 'deploy.crane', ownerHostId: null, projectId: null, projectSlug: null },
        { host_id: 4, project_id: '9', project_slug: 'orchestrator' },
      ),
    ).toEqual({ key: 'deploy.crane', hostId: 4, projectId: 9, projectSlug: 'orchestrator' });
  });

  it('yields nulls when neither the row nor the payload scopes the memory', () => {
    for (const payload of [null, undefined, 'not json', [], { node_id: 'memory:host:1' }]) {
      expect(resolveMemoryAuditContext(null, payload), JSON.stringify(payload) ?? 'undefined').toEqual({
        key: null,
        hostId: null,
        projectId: null,
        projectSlug: null,
      });
    }
  });

  it('drops host and project ids that are not positive safe integers', () => {
    for (const id of [0, -1, '', '0', 1.5, 'abc', null, Number.MAX_SAFE_INTEGER + 1, {}]) {
      expect(resolveMemoryAuditContext(null, { host_id: id, project_id: id }), String(id)).toMatchObject({
        hostId: null,
        projectId: null,
      });
    }
  });

  it('drops non-string keys and project slugs', () => {
    expect(resolveMemoryAuditContext(null, { memory_id: 42, project_slug: ['orchestrator'] })).toMatchObject({
      key: null,
      projectSlug: null,
    });
  });
});
