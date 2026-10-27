import { describe, expect, it } from 'vitest';
import { ownerToolProjection } from '../../../src/services/chatty/owner-actions.js';
import { signature } from '../../../src/services/chatty/contracts.js';
import type { OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import { RETENTION_POLICY_KEY } from '../../../src/services/server-retention/policy.js';

function snapshot(rows: Record<string, Record<string, unknown>[]>) {
  return { table: (name: string) => ({
    all: () => rows[name] ?? [],
    get: (id: string | number) => rows[name]?.find(row => (row.id ?? row.name) === id),
  }) } as unknown as OwnerStateSnapshot;
}
const proof = (name: string, args: Record<string, unknown>, rows: Record<string, Record<string, unknown>[]>) => signature(ownerToolProjection(name, args, snapshot(rows)));

describe('Chatty administrative approval targets', () => {
  it('binds inherited account policy and provider identity before generic account handling', () => {
    const rows = { providerAccounts: [{ id: 4, engine: 'grok' }], versions: [{ name: 'quota_policy_grok', version: 'old' }] };
    const before = proof('account_quota_policy_update', { id: 4 }, rows);
    expect(proof('account_quota_policy_update', { id: 4 }, { ...rows, versions: [{ name: 'quota_policy_grok', version: 'changed' }] })).not.toBe(before);
    expect(proof('account_quota_policy_update', { id: 4 }, { ...rows, providerAccounts: [{ id: 4, engine: 'codex' }] })).not.toBe(before);
  });
  it('binds workflow absence and immutable source versions for creation and revert', () => {
    const rows = { workflows: [{ id: 'wf', slug: 'deploy', currentVersion: 2 }], workflowVersions: [{ id: 'v1', workflowId: 'wf', documentHash: 'one' }] };
    expect(proof('workflow_create', { slug: 'deploy' }, rows)).not.toBe(proof('workflow_create', { slug: 'deploy' }, {}));
    expect(proof('workflow_revert', { workflow_id: 'deploy' }, rows)).not.toBe(proof('workflow_revert', { workflow_id: 'deploy' }, { ...rows, workflowVersions: [{ id: 'v1', workflowId: 'wf', documentHash: 'changed' }] }));
  });
  it('binds role proposal targets and current holder membership', () => {
    const rows = { agentRoles: [{ id: 'r', slug: 'reviewer' }], agentRoleProposals: [{ id: 'p', roleId: 'r', version: 1 }], agentRoleAssignments: [{ id: 'a', roleId: 'r', addressId: 'agent-a' }] };
    const before = proof('role_proposal_decide', { id: 'p' }, rows);
    expect(proof('role_proposal_decide', { id: 'p' }, { ...rows, agentRoleProposals: [{ id: 'p', roleId: 'r', version: 2 }] })).not.toBe(before);
    expect(proof('role_publish', { slug: 'reviewer' }, rows)).not.toBe(proof('role_publish', { slug: 'reviewer' }, { ...rows, agentRoleAssignments: [] }));
  });
  it('binds actual retention policy keys and affected ended sessions', () => {
    const rows = { versions: [{ name: RETENTION_POLICY_KEY, version: 'old' }], agentSessions: [{ id: 's', endedAt: '2026-10-27', expiresAt: 'old' }] };
    const before = proof('server_retention_policy_set', {}, rows);
    expect(proof('server_retention_policy_set', {}, { ...rows, versions: [{ name: RETENTION_POLICY_KEY, version: 'new' }] })).not.toBe(before);
    expect(proof('server_retention_policy_set', {}, { ...rows, agentSessions: [{ id: 's', endedAt: '2026-10-27', expiresAt: 'new' }] })).not.toBe(before);
  });
  it('fails closed for an uncomposed mutation domain', () => {
    expect(() => ownerToolProjection('generic_admin_write', {}, snapshot({}))).toThrow('explicit owner command composition');
  });
});
