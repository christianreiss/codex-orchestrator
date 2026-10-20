import { describe, expect, it } from 'vitest';
import {
  digest,
  workflowDocumentSchema,
  workflowMutationSchemas,
  type MutationInput,
} from '../../src/services/workflows/contract.js';
import {
  knowledgeUri,
  receiptBlocker,
  requiredKnowledge,
  validateKnowledgeReceipt,
} from '../../src/services/workflows/knowledge.js';

const document = () =>
  workflowDocumentSchema.parse({
    schema_version: 1,
    title: 'Source checks',
    summary: '',
    inputs: [],
    goal: { statement: 'Do work', success_criteria: [{ id: 'done', text: 'Verified' }] },
    tasks: [
      {
        id: 'work',
        title: 'Work',
        instructions: 'Work',
        acceptance_criteria: ['Verified'],
        depends_on: [],
        knowledge_ids: ['runbook'],
      },
      {
        id: 'other',
        title: 'Other',
        instructions: 'Other',
        acceptance_criteria: ['Verified'],
        depends_on: [],
        knowledge_ids: [],
      },
    ],
    knowledge: [
      {
        id: 'runbook',
        title: 'Runbook',
        reference: { uri: 'shared://runbook' },
        required_check: { applicability: 'Linux production hosts' },
      },
    ],
  });
const run = { workflowSha256: 'a'.repeat(64), createdAt: '2026-10-20T10:00:00.000Z' };
const now = '2026-10-20T10:10:00.000Z';
const receipt = (): MutationInput<'run_note'> => ({
  client_request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  run_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  kind: 'knowledge',
  task_id: 'work',
  text: 'Read and assessed',
  source: {
    knowledge_id: 'runbook',
    uri: 'shared://runbook',
    title: 'Runbook',
    read_at: now,
    digest: 'sha256:abcd',
    summary: 'Instructions read',
    applicability: 'applicable',
    applicability_reason: 'This task targets Linux production hosts',
  },
});
describe('required workflow knowledge', () => {
  it('opts in per knowledge source and linked task without changing historical documents', () => {
    const doc = document();
    expect(requiredKnowledge(doc, 'work')).toHaveLength(1);
    expect(requiredKnowledge(doc, 'other')).toEqual([]);
    delete doc.knowledge[0]!.required_check;
    expect(requiredKnowledge(doc, 'work')).toEqual([]);
    expect(() =>
      validateKnowledgeReceipt(
        doc,
        run,
        { ...receipt(), source: { ...receipt().source!, knowledge_id: undefined } },
        now,
      ),
    ).not.toThrow();
    expect(
      workflowDocumentSchema.safeParse({
        ...document(),
        knowledge: [{ ...document().knowledge[0], required_check: { applicability: ' ' } }],
      }).success,
    ).toBe(false);
  });
  it('accepts digest or revision receipts and persists failed-read/mismatch attestations without a fingerprint', () => {
    expect(() => validateKnowledgeReceipt(document(), run, receipt(), now)).not.toThrow();
    const entry = receipt();
    delete entry.source!.digest;
    entry.source!.revision = 'v4';
    expect(() => validateKnowledgeReceipt(document(), run, entry, now)).not.toThrow();
    for (const applicability of ['mismatch', 'unknown'] as const) {
      const failed = receipt();
      delete failed.source!.digest;
      failed.source!.applicability = applicability;
      expect(() => validateKnowledgeReceipt(document(), run, failed, now)).not.toThrow();
      expect(receiptBlocker(failed.source)).toMatch(/applicability_/);
    }
    const unreadable = receipt();
    delete unreadable.source!.digest;
    unreadable.source!.unavailable = true;
    expect(() => validateKnowledgeReceipt(document(), run, unreadable, now)).not.toThrow();
    expect(receiptBlocker(unreadable.source)).toBe('source_unavailable');
    expect(receiptBlocker()).toBe('missing_receipt');
    expect(receiptBlocker(receipt().source)).toBeNull();
  });
  it('rejects undeclared IDs, task scope, changed URIs, missing attestations and pre-run or future reads', () => {
    for (const patch of [
      { knowledge_id: 'missing' },
      { uri: 'https://different.example' },
      { read_at: '2026-10-20T09:59:59.999Z' },
      { read_at: '2026-10-20T10:10:00.001Z' },
      { digest: ' ', revision: ' ' },
      { applicability: undefined },
      { applicability_reason: ' ' },
    ])
      expect(() =>
        validateKnowledgeReceipt(
          document(),
          run,
          { ...receipt(), source: { ...receipt().source!, ...patch } },
          now,
        ),
      ).toThrow();
    expect(() =>
      validateKnowledgeReceipt(document(), run, { ...receipt(), task_id: 'other' }, now),
    ).toThrow();
    expect(() => validateKnowledgeReceipt(document(), run, { ...receipt(), kind: 'note' }, now)).toThrow();
  });
  it('pins inline identity and verifies its content digest while keeping remote URIs restricted', () => {
    const doc = document();
    doc.knowledge[0] = {
      id: 'runbook',
      title: 'Inline',
      inline: 'Linux\nrunbook',
      required_check: { applicability: 'Linux' },
    };
    const entry = receipt();
    entry.source!.uri = knowledgeUri(run, doc.knowledge[0]);
    entry.source!.digest = digest(doc.knowledge[0].inline);
    expect(workflowMutationSchemas.run_note.safeParse(entry).success).toBe(true);
    expect(() => validateKnowledgeReceipt(doc, run, entry, now)).not.toThrow();
    entry.source!.digest = 'wrong';
    expect(() => validateKnowledgeReceipt(doc, run, entry, now)).toThrow(/pinned inline/);
    expect(
      workflowMutationSchemas.run_note.safeParse({
        ...entry,
        source: { ...entry.source, uri: 'file:///etc/passwd' },
      }).success,
    ).toBe(false);
  });
});
