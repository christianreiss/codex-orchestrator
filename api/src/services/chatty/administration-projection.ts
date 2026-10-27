import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import type { OwnedTableName } from '../../control-plane/state/catalog.js';
import { RETENTION_POLICY_KEY, RETENTION_RUN_KEY } from '../server-retention/policy.js';

/** Metadata consulted by new administrative mutations, bound to the action approval. */
export function administrationProjection(name: string, args: Record<string, unknown>, state: OwnerStateSnapshot): unknown[] | undefined {
  const selected: unknown[] = [];
  const add = (table: OwnedTableName, predicate: (row: Record<string, unknown>) => boolean = () => true) => {
    selected.push(state.table(table).all().filter(row => predicate(row as unknown as Record<string, unknown>)));
  };
  if (name.startsWith('quota_') || name.startsWith('account_quota_')) {
    const account = name.startsWith('account_quota_') ? state.table('providerAccounts').get(Number(args.id)) : undefined;
    if (name.startsWith('account_quota_')) add('providerAccounts', row => row.id === args.id);
    const keys = name.startsWith('account_quota_')
      ? [`quota_policy_account_${String(args.id)}`, `quota_policy_${account?.engine ?? ''}`]
      : name.startsWith('quota_policy_') ? [`quota_policy_${String(args.engine)}`]
      : name.startsWith('quota_scaling_') ? ['usage_scaling_rules']
      : name.startsWith('quota_advice_') ? ['quota_advice']
      : ['quota_hard_fail', 'quota_limit_percent', 'quota_week_partition', 'quota_advice'];
    add('versions', row => keys.includes(String(row.name)));
  } else if (name.startsWith('workflow_')) {
    add('versions', row => ['workflows_enabled', 'agent_messaging_enabled'].includes(String(row.name)));
    if (name !== 'workflow_state_set') {
      const workflow = state.table('workflows').all().find(row =>
        row.id === args.workflow_id || row.slug === args.workflow_id || row.slug === args.slug);
      add('workflows', row => row.id === workflow?.id);
      add('workflowVersions', row => row.workflowId === workflow?.id);
    }
  } else if (name.startsWith('role_')) {
    add('versions', row => row.name === 'roles_enabled');
    if (name !== 'role_state_set') {
      const proposal = name === 'role_proposal_decide' ? state.table('agentRoleProposals').get(String(args.id)) : undefined;
      const role = state.table('agentRoles').all().find(row => row.slug === args.slug || row.id === proposal?.roleId);
      add('agentRoles', row => row.id === role?.id);
      add('agentRoleVersions', row => row.roleId === role?.id);
      const versionIds = new Set(state.table('agentRoleVersions').all().filter(row => row.roleId === role?.id).map(row => row.id));
      add('agentRoleVersionFiles', row => versionIds.has(String(row.versionId)));
      add('agentRoleAssignments', row => row.roleId === role?.id);
      add('agentRoleProposals', row => row.roleId === role?.id);
    }
  } else if (name.startsWith('server_retention_')) {
    add('versions', row => [RETENTION_POLICY_KEY, RETENTION_RUN_KEY].includes(String(row.name)));
    if (name === 'server_retention_policy_set') add('agentSessions', row => Boolean(row.endedAt));
  } else return undefined;
  return selected;
}
