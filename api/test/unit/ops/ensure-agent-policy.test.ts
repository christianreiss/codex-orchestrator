import { describe, expect, it } from 'vitest';
import { agentsDocuments, agentsDocumentState } from '../../../src/db/schema.js';
import { ensureAgentPolicy, LEGACY_V55_SHA256 } from '../../../src/ops/ensure-agent-policy.js';
import { defaultAgentPolicyComposition } from '../../../src/services/agent-policy-composer.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

type Row = Record<string, unknown>;

function makeDb(rows: Row[] = []): DbFake {
  const db = createDbFake(new Map<unknown, Row[]>([
    [agentsDocuments, rows],
    [agentsDocumentState, []],
  ]));
  const original = db.insert.bind(db);
  db.insert = (table: unknown) => {
    if (table !== agentsDocuments) return original(table);
    return {
      values: (values: Row) => {
        const docs = db.tables.get(agentsDocuments) ?? [];
        const id = docs.reduce((max, row) => Math.max(max, Number(row.id ?? 0)), 0) + 1;
        docs.unshift({ id, ...values });
        db.tables.set(agentsDocuments, docs);
        const result = Promise.resolve([{ insertId: id, affectedRows: 1 }]);
        return Object.assign(result, { $returningId: async () => [{ id }] });
      },
    };
  };
  return db;
}

function legacyRow(sha256: string): Row {
  return {
    id: 55,
    sha256,
    body: 'legacy',
    builderState: null,
    sourceHostId: null,
    engine: 'codex',
    createdAt: '2026-08-02T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
  };
}

describe('ensureAgentPolicy', () => {
  it('creates the full builder default once for a fresh database', async () => {
    const db = makeDb();
    const first = await ensureAgentPolicy(db as never);
    const second = await ensureAgentPolicy(db as never);

    expect(first.status).toBe('created_default');
    expect(second.status).toBe('already_builder');
    expect(db.tables.get(agentsDocuments)).toHaveLength(1);
    expect(db.tables.get(agentsDocuments)?.[0]?.builderState).toEqual(defaultAgentPolicyComposition());
  });

  it('converts only the exact production v55 signature and preserves the old row', async () => {
    const db = makeDb([legacyRow(LEGACY_V55_SHA256)]);
    const result = await ensureAgentPolicy(db as never);

    expect(result).toMatchObject({ status: 'converted_v55', version_id: 56 });
    expect(db.tables.get(agentsDocuments)?.map((row) => row.id)).toEqual([56, 55]);
    expect(db.tables.get(agentsDocuments)?.[0]?.builderState).toEqual(defaultAgentPolicyComposition());
  });

  it('leaves unknown legacy content untouched', async () => {
    const db = makeDb([legacyRow('a'.repeat(64))]);
    const result = await ensureAgentPolicy(db as never);

    expect(result.status).toBe('legacy_untouched');
    expect(db.tables.get(agentsDocuments)).toHaveLength(1);
  });
});
