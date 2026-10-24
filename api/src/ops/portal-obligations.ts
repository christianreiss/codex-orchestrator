import type { OwnerStateSnapshot } from '../control-plane/state/store.js';
import type { OwnerWorkObligation } from './owner-worker.js';
import type { MessagingMaintenanceFacts } from './owner-maintenance.js';
import { dependencyRevision } from './schedule-obligations.js';
import { receiverState, RECEIVER_FRESH_MS } from '../services/agent-receiver-state.js';

export const PORTAL_MAINTENANCE_TABLES = [
  'versions',
  'hosts',
  'agentSessions',
  'agentPrompts',
  'agentBusAddresses',
  'agentBusMessages',
  'agentRebootHandoffs',
  'agentResourceClaims',
  'agentSchedules',
  'agentWatchdogs',
  'agentRoleProposals',
  'agentChatNotices',
  'agentChatAttachments',
  'hostDaemonPortalBindings',
  'hostDaemonSessions',
  'agentBusGroups',
  'agentBusConferences',
  'agentScopes',
  'workflowRuns',
] as const;
export function portalObligations(
  snapshot: OwnerStateSnapshot,
  facts: MessagingMaintenanceFacts,
  _graceUntil: number,
  activity: (hostId: number) => { connected: boolean; lastAt: number | null } = () => ({
    connected: false,
    lastAt: null,
  }),
): OwnerWorkObligation[] {
  const revision = `${dependencyRevision(snapshot, PORTAL_MAINTENANCE_TABLES)}:${facts.revision()}`;
  const work: OwnerWorkObligation[] = [];
  const add = (key: string, at: number) => {
    if (Number.isFinite(at)) work.push({ key, revision, dueAt: at });
  };
  for (const session of snapshot.sessions.all()) {
    if (session.endedAt) {
      if (session.expiresAt) add(`session:${session.id}`, Date.parse(session.expiresAt));
      continue;
    }
    // A lost connection or expired authentication token does not prove native
    // process exit. Retain resumable identities and accepted work until an
    // authoritative roster/exit command applies a terminal transition.
    const receiver = receiverState(session.receiver);
    if (
      receiver &&
      snapshot
        .table('agentPrompts')
        .all()
        .some((row) => row.sessionId === session.id && row.status === 'open') &&
      !snapshot
        .table('hostDaemonPortalBindings')
        .all()
        .some((row) => row.portalSessionId === session.id)
    ) {
      if (receiver.failure || receiver.portal_closed) add(`receiver:${session.id}`, 0);
      else if (!facts.receiverConnected(session.id, session.bindingGeneration, receiver.generation))
        add(`receiver:${session.id}`, Date.parse(receiver.heartbeat_at) + RECEIVER_FRESH_MS);
    }
  }
  const rawDays = Number(snapshot.setting('inactivity_window_days') ?? 30);
  const days = Number.isFinite(rawDays) ? Math.max(0, Math.min(60, rawDays)) : 30;
  for (const host of snapshot.hosts.all()) {
    if (host.internalRole) continue;
    if (host.expiresAt) add(`host:expiry:${host.id}`, Date.parse(host.expiresAt));
    const observed = activity(host.id);
    const contact = Math.max(Date.parse(host.lastContactAt ?? host.createdAt), observed.lastAt ?? -Infinity);
    if (!observed.connected && days > 0) add(`host:inactive:${host.id}`, contact + days * 86_400_000 + 1);
    const provisioned =
      Number(host.apiCalls ?? 0) > 0 ||
      [
        host.clientVersion,
        host.wrapperVersion,
        host.authDigest,
        host.lastRefresh,
        host.claudeClientVersion,
        host.claudeWrapperVersion,
        host.claudeAuthDigest,
        host.claudeLastRefresh,
        host.grokClientVersion,
        host.grokWrapperVersion,
        host.grokAuthDigest,
        host.grokLastRefresh,
      ].some(Boolean);
    if (!observed.connected && !provisioned)
      add(`host:provision:${host.id}`, Math.max(Date.parse(host.createdAt), contact) + 1_800_001);
  }
  for (const file of snapshot.table('agentChatAttachments').all()) {
    if (file.status === 'retired') add(`attachment:${file.id}`, 0);
    else if (['uploading', 'ready'].includes(file.status))
      add(`attachment:${file.id}`, Date.parse(file.updatedAt) + 86_400_001);
    // Scope removal can orphan even a previously published attachment.
    const exists =
      snapshot.sessions.get(file.sessionId) ||
      snapshot.table('hostDaemonSessions').get(file.sessionId) ||
      snapshot.table('agentBusGroups').get(file.sessionId) ||
      snapshot.table('agentBusConferences').get(file.sessionId) ||
      snapshot.table('agentScopes').get(file.sessionId) ||
      snapshot
        .table('hostDaemonPortalBindings')
        .all()
        .some((row) => row.daemonSessionId === file.sessionId && snapshot.sessions.get(row.portalSessionId));
    if (!exists) add(`attachment:orphan:${file.id}`, 0);
  }
  return work;
}
