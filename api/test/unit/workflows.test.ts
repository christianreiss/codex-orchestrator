import { describe, expect, it } from 'vitest';
import {
  workflowDocumentSchema,
  validateInputs,
  canonical,
  referenceUri,
} from '../../src/services/workflows/contract.js';
import { compactRunMutation } from '../../src/services/workflows/store.js';
const document = () => ({
  schema_version: 1,
  title: 'Test',
  summary: '',
  goal: { statement: 'Done', success_criteria: [{ id: 'done', text: 'Verified' }] },
  inputs: [],
  knowledge: [],
  tasks: [
    {
      id: 'one',
      title: 'One',
      instructions: 'Act',
      acceptance_criteria: ['Proof'],
      depends_on: [],
      knowledge_ids: [],
    },
  ],
});
describe('workflow contract', () => {
  it('keeps execution revisions, claims and outcomes without repeating long prepared instructions', () => {
    const instructions = 'Read and execute the pinned task. '.repeat(10000);
    const result = { run_id: 'run', workflow_id: 'workflow', version: 9, status: 'running',
      coordinator: { generation: 3, lease_until: 'future' }, report_url: 'https://fleet.example/run',
      claim_token: 'one-time-token', claim_generation: 4, event_sequence: 12, sequence: 12,
      task: { task_id: 'one', version: 6, status: 'running', claim: { generation: 4 } },
      preparation: { phase: 'ready', revision: 2, summary: { revision: 2, tasks: [{ instructions }] },
        confirmation: { summary_revision: 2, user_confirmation: instructions } },
      inputs: { long: instructions }, results: { long: instructions } };
    const compact = compactRunMutation(result);
    expect(compact).toEqual({ run_id: 'run', workflow_id: 'workflow', version: 9, status: 'running',
      coordinator: result.coordinator, report_url: result.report_url,
      claim_token: result.claim_token, claim_generation: 4, event_sequence: 12, sequence: 12,
      task: result.task, compact: true,
      preparation: { phase: 'ready', revision: 2, summary_revision: 2, confirmed_summary_revision: 2 } });
    expect(JSON.stringify(compact).length).toBeLessThan(1000);
    expect(result.preparation.summary.tasks[0]!.instructions).toBe(instructions);
    expect(compactRunMutation({ run_id: 'legacy', preparation: null }).preparation).toBeNull();
  });
  it('requires one goal and tasks but allows zero knowledge', () => {
    expect(workflowDocumentSchema.safeParse(document()).success).toBe(true);
    expect(workflowDocumentSchema.safeParse({ ...document(), tasks: [] }).success).toBe(false);
    expect(workflowDocumentSchema.safeParse({ ...document(), goals: [{}, {}] }).success).toBe(false);
  });
  it('rejects duplicate identifiers, unknown references, self dependencies and cycles', () => {
    for (const dep of ['missing', 'one'])
      expect(
        workflowDocumentSchema.safeParse({
          ...document(),
          tasks: [{ ...document().tasks[0], depends_on: [dep] }],
        }).success,
      ).toBe(false);
    expect(
      workflowDocumentSchema.safeParse({ ...document(), tasks: [document().tasks[0], document().tasks[0]] })
        .success,
    ).toBe(false);
    expect(
      workflowDocumentSchema.safeParse({
        ...document(),
        tasks: [
          { ...document().tasks[0], id: 'one', depends_on: ['two'] },
          { ...document().tasks[0], id: 'two', depends_on: ['one'] },
        ],
      }).success,
    ).toBe(false);
  });
  it('types defaults and rejects wrong or unknown inputs', () => {
    const d = workflowDocumentSchema.parse({
      ...document(),
      inputs: [{ key: 'size', label: 'Size', type: 'number', required: true, default: 4 }],
    });
    expect(validateInputs(d, {})).toEqual({ size: 4 });
    expect(() => validateInputs(d, { size: '4' })).toThrow();
    expect(() => validateInputs(d, { extra: 1 })).toThrow();
  });
  it('accepts fleet references and disallows local memories, dangerous URLs or unknown project content', () => {
    for (const uri of [
      'shared://facts',
      'project://abc/memory/fact',
      'project://abc/files/file',
      'skill://workflow',
      'https://example.com',
    ])
      expect(referenceUri.safeParse(uri).success).toBe(true);
    for (const uri of [
      'memory://host',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'project://abc/secret/value',
      'https://test\n.example',
    ])
      expect(referenceUri.safeParse(uri).success).toBe(false);
  });
  it('canonicalizes object keys and preserves ordered arrays', () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});
