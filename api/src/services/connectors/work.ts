import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import { allowed, targetAllowed, type ConnectorPolicy } from './policy.js';
import type { Grant } from './oauth.js';
export interface ConnectorWork {
  grantId: string;
  userId: number;
  hostId: number;
  sessionId: string;
}
export function connectorWorkAllowed(snapshot: OwnerStateSnapshot, work: ConnectorWork): boolean {
  const row = snapshot.table('connectorRecords').get(`grant:${work.grantId}`),
    p = snapshot.table('connectorRecords').get('policy'),
    user = snapshot.table('adminUsers').get(work.userId);
  if (!row || (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) || !p || !user?.active) return false;
  const grant = JSON.parse(row.bodyJson) as Grant,
    policy = JSON.parse(p.bodyJson) as ConnectorPolicy;
  const session = snapshot.sessions.get(work.sessionId);
  return (
    !!session &&
    session.hostId === work.hostId &&
    grant.userId === work.userId &&
    policy.enabled &&
    policy.providers[grant.provider] &&
    grant.operations.includes('agent_delegate') &&
    allowed(grant.scope, policy.ceiling, user.accessLevel, 'agent_delegate', {
      category: 'coordination',
      capability: 'agent_portal.manage',
      write: true,
      sensitive: 'delegate',
    }) &&
    targetAllowed(grant.scope, policy.ceiling, 'hosts', work.hostId)
  );
}
export function connectorMessageAllowed(
  snapshot: OwnerStateSnapshot,
  messageId: string,
  connectorGrantId: string | null | undefined,
): boolean {
  const row = snapshot.table('connectorRecords').get(`work:${messageId}`);
  if (!row) return !connectorGrantId;
  if (connectorGrantId && (JSON.parse(row.bodyJson) as ConnectorWork).grantId !== connectorGrantId)
    return false;
  return connectorWorkAllowed(snapshot, JSON.parse(row.bodyJson) as ConnectorWork);
}
