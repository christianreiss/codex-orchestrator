/**
 * The input gates the admin memory routes hand raw JSON to. `create()` and
 * `update()` run their per-scope allowlist, the immutable identity fields and
 * the id/key/slug alias check before opening a transaction, so a db stub that
 * throws on any property read proves both the rejection and that a rejected
 * payload never reaches a writer.
 *
 * The unknown-field tables are spelled out per scope on purpose: deriving them
 * by subtracting the allowlist would shrink silently the moment an allowlist
 * widened, which is the regression these tests exist to catch.
 */
import { describe, expect, it } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import { ValidationError } from '../../../src/http/errors.js';
import { AdminMemoryLifecycle } from '../../../src/services/admin-memory-lifecycle.js';
import { MEMORY_SCOPES, type MemoryScope } from '../../../src/services/admin-memory-model.js';

const ACTOR_ID = 3;
const RECORD_ID = 41;

/** Thrown in place of every db call, so "reached the writer" is observable. */
class DbReached extends Error {}

function makeDb(): { db: Database; touched: string[] } {
  const touched: string[] = [];
  const db = new Proxy(
    {},
    {
      get(_target: object, prop: string | symbol) {
        touched.push(String(prop));
        return () => {
          throw new DbReached(`db.${String(prop)} was called`);
        };
      },
    },
  ) as unknown as Database;
  return { db, touched };
}

async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (error: unknown) => error,
  );
}

async function expectValidation(
  call: Promise<unknown>,
  touched: string[],
  message: string,
  param: string,
): Promise<void> {
  const error = await rejectionOf(call);
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).message).toBe(message);
  expect((error as ValidationError).param).toBe(param);
  expect(touched).toEqual([]);
}

async function expectPassedGate(call: Promise<unknown>, touched: string[]): Promise<void> {
  const error = await rejectionOf(call);
  expect(error).toBeInstanceOf(DbReached);
  expect(touched).toEqual(['transaction']);
}

/** Fields each scope must refuse on create, including the other scopes' fields. */
const CREATE_UNKNOWN: Record<MemoryScope, string[]> = {
  host: ['slug', 'title', 'project_id', 'project_slug', 'node_id', 'record_id', 'scope', 'revision'],
  project: [
    'slug',
    'summary',
    'title',
    'engine',
    'host_id',
    'project_id',
    'node_id',
    'record_id',
    'scope',
    'revision',
  ],
  shared: ['host_id', 'project_id', 'project_slug', 'node_id', 'record_id', 'scope', 'revision'],
};

/** Fields each scope must refuse on update once a mutable field is present. */
const UPDATE_UNKNOWN: Record<MemoryScope, string[]> = {
  host: ['title', 'revision', 'created_at'],
  project: ['summary', 'title', 'engine', 'revision', 'created_at'],
  shared: ['revision', 'created_at'],
};

const IMMUTABLE_FIELDS = [
  'id',
  'key',
  'slug',
  'node_id',
  'record_id',
  'scope',
  'host_id',
  'project_id',
  'project_slug',
];

const FULL_PATCH: Record<MemoryScope, Record<string, unknown>> = {
  host: { content: 'body', metadata: { owner: 'ops' }, tags: ['ops'], summary: 'why', engine: 'codex' },
  project: { content: 'body', metadata: { owner: 'ops' }, tags: ['ops'] },
  shared: {
    content: 'body',
    metadata: { owner: 'ops' },
    tags: ['ops'],
    summary: 'why',
    title: 'Deploy notes',
    engine: 'codex',
  },
};

describe('AdminMemoryLifecycle create input gate', () => {
  for (const scope of MEMORY_SCOPES) {
    it(`refuses every field outside the ${scope} create allowlist`, async () => {
      for (const field of CREATE_UNKNOWN[scope]) {
        const { db, touched } = makeDb();
        await expectValidation(
          new AdminMemoryLifecycle(db).create(scope, { [field]: 'x' }, ACTOR_ID),
          touched,
          `Unknown field for ${scope} memory: ${field}`,
          field,
        );
      }
    });
  }

  it('refuses create payloads whose identity aliases disagree', async () => {
    const mismatched: Array<[MemoryScope, Record<string, unknown>]> = [
      ['host', { id: 'deploy.crane', key: 'deploy.other', host_id: 1, content: 'body' }],
      // Only the shared scope case-folds, so host aliases must match exactly.
      ['host', { id: 'Deploy.Crane', key: 'deploy.crane', host_id: 1, content: 'body' }],
      ['project', { id: 'deploy.crane', key: 'deploy.other', project_slug: 'demo', content: 'body' }],
      ['shared', { id: 'deploy-notes', slug: 'deploy-other', content: 'body' }],
      ['shared', { id: 'deploy-notes', key: 'deploy-other', content: 'body' }],
    ];
    for (const [scope, input] of mismatched) {
      const { db, touched } = makeDb();
      await expectValidation(
        new AdminMemoryLifecycle(db).create(scope, input, ACTOR_ID),
        touched,
        'Memory identity aliases must match',
        'id',
      );
    }
  });

  it('lets agreeing, blank and non-string identity aliases through to the writer', async () => {
    const accepted: Array<[MemoryScope, Record<string, unknown>]> = [
      ['host', { id: 'deploy.crane', key: 'deploy.crane', host_id: 1, content: 'body' }],
      ['host', { id: 'deploy.crane', key: '   ', host_id: 1, content: 'body' }],
      ['host', { id: 'deploy.crane', key: 42, host_id: 1, content: 'body' }],
      ['project', { id: 'deploy.crane', key: 'deploy.crane', project_slug: 'demo', content: 'body' }],
      // Shared aliases are compared case-folded and trimmed.
      ['shared', { id: 'Deploy-Notes', slug: 'deploy-notes', key: 'DEPLOY-NOTES', content: 'body' }],
      ['shared', { id: '  deploy-notes  ', slug: 'deploy-notes', content: 'body' }],
    ];
    for (const [scope, input] of accepted) {
      const { db, touched } = makeDb();
      await expectPassedGate(new AdminMemoryLifecycle(db).create(scope, input, ACTOR_ID), touched);
    }
  });
});

describe('AdminMemoryLifecycle mutable patch gate', () => {
  for (const scope of MEMORY_SCOPES) {
    it(`refuses every immutable identity field on ${scope} update`, async () => {
      for (const field of IMMUTABLE_FIELDS) {
        const { db, touched } = makeDb();
        await expectValidation(
          new AdminMemoryLifecycle(db).update(
            scope,
            RECORD_ID,
            { [field]: 'x', content: 'body', expected_etag: 'etag' },
            ACTOR_ID,
          ),
          touched,
          `${field} is immutable`,
          field,
        );
      }
    });

    it(`refuses every field outside the ${scope} update allowlist`, async () => {
      for (const field of UPDATE_UNKNOWN[scope]) {
        const { db, touched } = makeDb();
        await expectValidation(
          new AdminMemoryLifecycle(db).update(
            scope,
            RECORD_ID,
            { content: 'body', [field]: 'x', expected_etag: 'etag' },
            ACTOR_ID,
          ),
          touched,
          `Unknown or immutable field: ${field}`,
          field,
        );
      }
    });

    it(`refuses a ${scope} patch that carries no mutable field`, async () => {
      for (const input of [{ expected_etag: 'etag' }, {}]) {
        const { db, touched } = makeDb();
        await expectValidation(
          new AdminMemoryLifecycle(db).update(scope, RECORD_ID, input, ACTOR_ID),
          touched,
          'At least one mutable field is required',
          'body',
        );
      }
    });

    it(`lets a full ${scope} patch through to the writer`, async () => {
      const { db, touched } = makeDb();
      await expectPassedGate(
        new AdminMemoryLifecycle(db).update(
          scope,
          RECORD_ID,
          { ...FULL_PATCH[scope], expected_etag: 'etag' },
          ACTOR_ID,
        ),
        touched,
      );
    });
  }
});
