import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { createRequire } from 'node:module';
const addFormats = createRequire(import.meta.url)('ajv-formats') as (instance: Ajv) => void;
import { workflowMutationSchemas } from '../../../src/services/workflows/contract.js';
import { workflowToolSchema } from '../../../src/services/workflow-tool-schemas.js';
import { buildManagedWorkflowSkills, isManagedWorkflowSlug } from '../../../src/services/managed-workflows-skill.js';

const source = await readFile(new URL('../../../../wrappers/cxx/internal/agentbus/workflows.go', import.meta.url), 'utf8');
const marker = 'const workflowToolDefinitions = `';
const tools = JSON.parse(source.slice(source.indexOf(marker) + marker.length).trim().slice(0, -1)) as { name: string; inputSchema: Record<string, unknown> }[];

describe('workflow tool transport contract', () => {
  it('ships the exact Zod action contracts once for Codex, Claude and Grok', () => {
    expect(tools).toHaveLength(13);
    for (const tool of tools.filter(t => t.name !== 'agent_workflow_run_current')) {
      const operation = tool.name.slice('agent_workflow_'.length) as keyof typeof workflowMutationSchemas;
      expect(tool.inputSchema, operation).toEqual({ type: 'object', ...workflowToolSchema(workflowMutationSchemas[operation]) });
    }
  });
  it('enforces action fields and rejects invented actor identities at MCP discovery', () => {
    const ajv = new Ajv({ strict: false }); addFormats(ajv);
    const get = (name: string) => ajv.compile(tools.find(t => t.name === name)!.inputSchema);
    const base = { client_request_id: '11111111-1111-4111-8111-111111111111', run_id: '22222222-2222-4222-8222-222222222222', task_id: 'verify', expected_task_version: 1 };
    const claim = get('agent_workflow_task_claim');
    expect(claim({ ...base, action: 'acquire' })).toBe(true);
    expect(claim({ ...base, action: 'renew' })).toBe(false);
    expect(claim({ ...base, action: 'acquire', agent_uuid: 'spoof' })).toBe(false);
    expect(claim({ ...base, action: 'renew', claim_token: 'a'.repeat(24), claim_generation: 1 })).toBe(true);
    const update = get('agent_workflow_task_update');
    expect(update({ ...base, action: 'retry', reason: 'Prior failure is resolved' })).toBe(true);
    expect(update({ ...base, action: 'result', status: 'succeeded', summary: 'OK' })).toBe(false);
    const membership = get('agent_workflow_membership');
    expect(membership({ client_request_id: base.client_request_id, run_id: base.run_id, action: 'accept', invitation_id: base.client_request_id, reason: 'Access verified' })).toBe(true);
    expect(membership({ client_request_id: base.client_request_id, run_id: base.run_id, action: 'accept', reason: 'No invitation' })).toBe(false);
  });
  it('reserves both managed skills and keeps invitation, task results and bus outcomes distinct', () => {
    expect(isManagedWorkflowSlug('invite')).toBe(true);
    expect(isManagedWorkflowSlug('workflows')).toBe(true);
    const [workflow, invite] = buildManagedWorkflowSkills('2026-10-20T00:00:00Z');
    expect(workflow!.manifest).toContain('WORKFLOW-QUESTION/1');
    expect(workflow!.manifest).toContain('agent_task_result');
    expect(workflow!.manifest).toContain('expected_workflow_version');
    expect(invite!.manifest).toContain('skill://workflows');
    expect(invite!.manifest).toContain('unambiguous active run');
  });
});
