import type { CanonicalBodyProof } from './canonical-metadata.js';
import type { CompanionEventIndex } from './companion-index.js';
import type { RoomHead } from './room-heads.js';
import type { ProjectEventMetadata } from './project-history.js';
import { AGENT_MESSAGING_MISSED_WINDOW_SECONDS } from '../../services/agent-messaging/constants.js';
import { domainHistoryPredicate } from './working-history.js';
import {
  getTableColumns,
  getTableName,
  is,
  type SQL,
  eq,
  isNull,
  notInArray,
  sql,
  or,
  and,
} from 'drizzle-orm';
import { getTableConfig, MySqlTable, type AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import * as schema from '../../db/schema.js';

/** Explicit storage policy. Adding a table requires an ownership decision. */
export const TABLE_POLICY = {
  controlPlaneOwner: 'cold',
  controlPlaneCommandReceipts: 'cold',
  controlPlaneOutbox: 'owned',
  hosts: 'owned',
  hostAuthDigests: 'owned',
  hostUsers: 'owned',
  authPayloads: 'owned',
  providerAccounts: 'owned',
  providerAccountSessions: 'owned',
  grokAuthRefreshState: 'owned',
  authCanonicalHeads: 'owned',
  authEntries: 'cold',
  hostAuthStates: 'owned',
  installTokens: 'owned',
  hostSpawns: 'owned',
  authSeedTokens: 'owned',
  cliAuthRequests: 'owned',
  skills: 'owned',
  skillFiles: 'owned',
  secrets: 'owned',
  claudeArtifacts: 'owned',
  agentsDocuments: 'owned',
  agentsDocumentState: 'owned',
  agentPolicyProfiles: 'owned',
  agentPolicyProfileAssignments: 'owned',
  clientConfigDocuments: 'owned',
  mcpMemories: 'owned',
  coordProjects: 'owned',
  coordProjectNotes: 'owned',
  coordProjectTodos: 'owned',
  coordProjectFiles: 'owned',
  coordProjectFeedback: 'owned',
  coordProjectMemories: 'owned',
  coordProjectEvents: 'cold',
  coordProjectBoards: 'owned',
  coordProjectBoardColumns: 'owned',
  coordProjectCards: 'owned',
  coordProjectCardDeps: 'owned',
  sharedMemories: 'owned',
  sharedMemoryChunks: 'cold',
  sharedMemoryRevisions: 'cold',
  adminUsers: 'owned',
  adminSessions: 'owned',
  adminPasswordResets: 'owned',
  adminPasskeys: 'owned',
  adminWebauthnChallenges: 'owned',
  adminEvents: 'cold',
  insecureAuthRequests: 'owned',
  insecureDomainAllows: 'owned',
  chatgptUsageSnapshots: 'owned',
  claudeUsageSnapshots: 'owned',
  grokUsageSnapshots: 'owned',
  dashboardGraphQuotaSnapshots: 'cold',
  logs: 'cold',
  mcpSessionTokens: 'owned',
  versions: 'owned',
  openaiApiKeys: 'owned',
  dashboardGraphClaudeQuotaSnapshots: 'cold',
  wrapperSigningKeys: 'owned',
  wrapperV2Binaries: 'owned',
  agentNamePool: 'owned',
  agentNameLeases: 'owned',
  agentSessions: 'owned',
  agentEvents: 'cold',
  agentPrompts: 'owned',
  agentMessages: 'owned',
  agentBusAddresses: 'owned',
  agentBusGroups: 'owned',
  agentBusSubscriptions: 'owned',
  agentBusPublications: 'owned',
  agentBusConversations: 'owned',
  agentBusConferences: 'owned',
  agentBusConferenceMembers: 'owned',
  agentBusMessages: 'owned',
  agentBusRelays: 'owned',
  gitClones: 'owned',
  gitWorktrees: 'owned',
  gitMergeRequests: 'owned',
  agentTransfers: 'owned',
  agentTransferEvents: 'cold',
  schemaMigrations: 'owned',
  companionPairings: 'owned',
  companionDevices: 'owned',
  companionFollows: 'owned',
  companionNotifications: 'owned',
  agentSchedules: 'owned',
  agentScheduleRuns: 'owned',
  agentTaskResults: 'owned',
  agentFreshStartGrants: 'owned',
  agentWatchdogs: 'owned',
  hostDaemons: 'owned',
  hostDaemonSessions: 'owned',
  hostDaemonOperations: 'owned',
  advisorSessions: 'owned',
  hostDaemonPortalBindings: 'owned',
  companionDaemonFollows: 'owned',
  chattySessions: 'owned',
  chattyRuns: 'owned',
  chattyEvents: 'cold',
  chattyActions: 'owned',
  sessionHousekeepingReservations: 'owned',
  agentRebootHandoffs: 'owned',
  agentChatAttachments: 'owned',
  agentChatNotices: 'owned',
  feedbackItems: 'owned',
  feedbackPipeline: 'owned',
  feedbackEvents: 'cold',
  agentNativeControls: 'owned',
  engineDestroyHosts: 'owned',
  agentScopes: 'owned',
  agentScopeBindings: 'owned',
  agentScopeMembers: 'owned',
  agentScopeEvents: 'owned',
  agentResourceClaims: 'owned',
  agentRoomEvents: 'owned',
  agentRoomReads: 'owned',
  agentRoomOperations: 'owned',
  agentRoomDeliveries: 'owned',
  agentRoles: 'owned',
  agentRoleVersions: 'owned',
  agentRoleBlobs: 'cold',
  agentRoleVersionFiles: 'owned',
  agentRoleAssignments: 'owned',
  agentRoleProposals: 'owned',
  agentRoleProposalEvents: 'cold',
  workflows: 'owned',
  workflowVersions: 'owned',
  workflowRuns: 'owned',
  workflowRunMembers: 'owned',
  workflowRunInvitations: 'owned',
  workflowRunTasks: 'owned',
  workflowTaskAttempts: 'owned',
  workflowRunEvents: 'owned',
  workflowRunEvaluations: 'owned',
  workflowMutations: 'cold',
} as const;

type Tables = typeof schema;
export type SchemaTableName = { [K in keyof Tables]: Tables[K] extends MySqlTable ? K : never }[keyof Tables];
export type OwnedTableName = {
  [K in keyof typeof TABLE_POLICY]: (typeof TABLE_POLICY)[K] extends 'owned' ? K : never;
}[keyof typeof TABLE_POLICY];
export type Row<K extends OwnedTableName> = Tables[K]['$inferSelect'];
type ColdField =
  | `${string}Enc`
  | 'apiKey'
  | 'body'
  | 'content'
  | 'manifest'
  | 'passwordHash'
  | 'secretResponse'
  | 'prevContent'
  | 'raw'
  | 'error';
export type StateRow<K extends OwnedTableName> = Omit<Row<K>, Extract<keyof Row<K>, ColdField>> &
  (K extends 'authPayloads'
    ? { canonicalBodyProof: CanonicalBodyProof | null }
    : K extends 'agentBusGroups' | 'agentBusConferences' | 'agentScopes'
      ? { roomHead: RoomHead }
      : K extends 'agentRoomReads'
        ? { unreadCount: number }
        : K extends 'agentRoleVersions'
          ? { roleLabel: string | null }
          : K extends 'chattySessions'
            ? { eventCursor: number }
            : K extends 'coordProjects'
              ? { recentEvents: ProjectEventMetadata[] }
              : K extends 'coordProjectNotes'
                ? { bodyPreview: string; bodyLength: number }
                : K extends 'coordProjectMemories'
                  ? { contentPreview: string; contentLength: number }
                  : K extends 'coordProjectFiles'
                    ? { sizeBytes: number; contentTail: string }
                    : K extends 'adminUsers'
                      ? { credentialDigest: string }
                      : K extends 'hosts'
                        ? {
                            credentialLookupHash: string;
                            authFingerprint: string;
                            registrationAt: string | null;
                          }
                        : K extends 'sharedMemories'
                          ? { contentPreview: string; highestRevision: number }
                          : K extends 'companionDevices'
                            ? { pushTokenDigest: string | null }
                            : K extends 'agentBusConversations'
                              ? { lastToASequence: number; lastToBSequence: number }
                              : K extends 'agentSessions'
                                ? {
                                    companionEvents: CompanionEventIndex;
                                    taskTitle: string | null;
                                    taskTitleNativeId: string | null;
                                    taskTitleEventId: number | null;
                                    portalEventCursor: number;
                                    portalAttentionCursor: number;
                                    portalAttentionClearedCursor: number;
                                    portalLastEventType: string | null;
                                    portalLastEventAt: string | null;
                                  }
                                : unknown);
export type StateSeed = { [K in OwnedTableName]?: readonly (StateRow<K> | Row<K>)[] };
export const OWNED_TABLE_NAMES = Object.freeze(
  Object.keys(TABLE_POLICY).filter(
    (k) => TABLE_POLICY[k as keyof typeof TABLE_POLICY] === 'owned',
  ) as OwnedTableName[],
);

export function isColdField(field: string): boolean {
  return (
    field.endsWith('Enc') ||
    [
      'apiKey',
      'body',
      'content',
      'manifest',
      'passwordHash',
      'secretResponse',
      'prevContent',
      'raw',
      'error',
    ].includes(field)
  );
}

export function assertSchemaCoverage(): void {
  for (const [name, table] of Object.entries(schema)) {
    if (is(table, MySqlTable) && !(name in TABLE_POLICY))
      throw new Error(`State ownership policy missing for ${name}`);
  }
}

export function stateColumns<K extends OwnedTableName>(name: K): Record<string, AnyMySqlColumn> {
  return Object.fromEntries(
    Object.entries(getTableColumns(schema[name])).filter(([key]) => !isColdField(key)),
  );
}

export function stateKeyFields(name: OwnedTableName): readonly string[] {
  const table = schema[name];
  const config = getTableConfig(table);
  const columns = getTableColumns(table);
  const key = config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
  const selected = key.length ? key : config.indexes.find((index) => index.config.unique)?.config.columns;
  if (!selected?.length) throw new Error(`Owned table ${name} has no stable primary or unique key`);
  return selected.map((column) => {
    const found = Object.entries(columns).find(([, value]) => value === column)?.[0];
    if (!found || isColdField(found)) throw new Error(`Owned table ${name} has an unsupported state key`);
    return found;
  });
}

export function stateTableName(name: OwnedTableName): string {
  return getTableName(schema[name]);
}

/** Exclude only rows proven terminal; unresolved and ambiguous work survives boot. */
export function workingSetPredicate(name: OwnedTableName): SQL | undefined {
  const domainHistory = domainHistoryPredicate(name);
  if (domainHistory) return domainHistory;
  switch (name) {
    case 'clientConfigDocuments':
      return sql`NOT EXISTS (SELECT 1 FROM client_config_documents n WHERE n.engine = ${schema.clientConfigDocuments.engine} AND n.id > ${schema.clientConfigDocuments.id})`;
    case 'agentBusMessages':
      return or(
        and(
          eq(schema.agentBusMessages.status, 'expired'),
          sql`${schema.agentBusMessages.expiredAt} > ${new Date(Date.now() - AGENT_MESSAGING_MISSED_WINDOW_SECONDS * 1000).toISOString()}`,
        ),
        sql`EXISTS (SELECT 1 FROM agent_bus_messages child WHERE child.digest_id = ${schema.agentBusMessages.id} AND child.status = 'batched')`,
        sql`EXISTS (SELECT 1 FROM agent_bus_messages reply WHERE reply.reply_to_message_id = ${schema.agentBusMessages.id} AND reply.status NOT IN ('completed','delivered','digested','dead','expired','canceled','superseded'))`,
        sql`EXISTS (SELECT 1 FROM agent_schedule_runs r WHERE r.message_id = ${schema.agentBusMessages.id} AND r.status IN ('waiting','queued','leased','accepted','recovering','capacity_wait'))`,
        sql`EXISTS (SELECT 1 FROM agent_watchdogs w WHERE w.message_id = ${schema.agentBusMessages.id} AND w.status IN ('watching','recovering','capacity_wait'))`,
        sql`${schema.agentBusMessages.presenceNoticeKey} IS NOT NULL AND EXISTS (SELECT 1 FROM agent_sessions recipient WHERE recipient.id = SUBSTRING_INDEX(${schema.agentBusMessages.presenceNoticeKey}, ':', 1) AND recipient.ended_at IS NULL) AND EXISTS (SELECT 1 FROM agent_sessions sender WHERE sender.id = ${schema.agentBusMessages.targetSessionId} AND sender.ended_at IS NULL)`,
        notInArray(schema.agentBusMessages.status, [
          'completed',
          'delivered',
          'digested',
          'dead',
          'expired',
          'canceled',
          'superseded',
        ]),
        and(
          eq(schema.agentBusMessages.senderAddressId, '00000000-0000-4000-8000-000000000001'),
          notInArray(schema.agentBusMessages.status, [
            'completed',
            'dead',
            'expired',
            'canceled',
            'ambiguous',
          ]),
          sql`EXISTS (SELECT 1 FROM agent_room_deliveries d JOIN agent_room_events e ON e.id = d.event_id JOIN agent_bus_conferences c ON c.id = e.room_id WHERE d.message_id = ${schema.agentBusMessages.id} AND c.status <> 'adjourned')`,
        ),
      );
    case 'agentRoomEvents':
      return sql`${schema.agentRoomEvents.createdAt}>${new Date(Date.now() - 60000).toISOString()} OR EXISTS (SELECT 1 FROM agent_room_deliveries d JOIN agent_bus_messages m ON m.id = d.message_id JOIN agent_bus_conferences c ON c.id = ${schema.agentRoomEvents.roomId} WHERE d.event_id = ${schema.agentRoomEvents.id} AND c.status <> 'adjourned' AND m.sender_address_id = '00000000-0000-4000-8000-000000000001' AND m.status NOT IN ('completed','dead','expired','canceled','ambiguous'))`;
    case 'agentRoomDeliveries':
      return sql`EXISTS (SELECT 1 FROM agent_room_events e JOIN agent_bus_conferences c ON c.id = e.room_id JOIN agent_bus_messages m ON m.id = ${schema.agentRoomDeliveries.messageId} WHERE e.id = ${schema.agentRoomDeliveries.eventId} AND c.status <> 'adjourned' AND m.sender_address_id = '00000000-0000-4000-8000-000000000001' AND m.status NOT IN ('completed','dead','expired','canceled','ambiguous'))`;
    case 'chatgptUsageSnapshots':
      return or(
        sql`${schema.chatgptUsageSnapshots.fetchedAt} >= DATE_FORMAT(UTC_DATE(), '%Y-%m-%dT00:00:00.000Z') AND ${schema.chatgptUsageSnapshots.status} IN ('ok','rate_limited') AND ((${schema.chatgptUsageSnapshots.primaryLimitSeconds} = 604800 AND ${schema.chatgptUsageSnapshots.primaryUsedPercent} IS NOT NULL) OR (${schema.chatgptUsageSnapshots.secondaryLimitSeconds} = 604800 AND ${schema.chatgptUsageSnapshots.secondaryUsedPercent} IS NOT NULL)) AND NOT EXISTS (SELECT 1 FROM chatgpt_usage_snapshots n WHERE n.account_id <=> ${schema.chatgptUsageSnapshots.accountId} AND n.fetched_at >= DATE_FORMAT(UTC_DATE(), '%Y-%m-%dT00:00:00.000Z') AND n.status IN ('ok','rate_limited') AND ((n.primary_limit_seconds = 604800 AND n.primary_used_percent IS NOT NULL) OR (n.secondary_limit_seconds = 604800 AND n.secondary_used_percent IS NOT NULL)) AND (n.fetched_at < ${schema.chatgptUsageSnapshots.fetchedAt} OR (n.fetched_at = ${schema.chatgptUsageSnapshots.fetchedAt} AND n.id < ${schema.chatgptUsageSnapshots.id})))`,
        sql`NOT EXISTS (SELECT 1 FROM chatgpt_usage_snapshots n WHERE n.account_id <=> ${schema.chatgptUsageSnapshots.accountId} AND n.id > ${schema.chatgptUsageSnapshots.id})`,
        sql`NOT EXISTS (SELECT 1 FROM chatgpt_usage_snapshots n WHERE n.account_id <=> ${schema.chatgptUsageSnapshots.accountId} AND (n.fetched_at > ${schema.chatgptUsageSnapshots.fetchedAt} OR (n.fetched_at = ${schema.chatgptUsageSnapshots.fetchedAt} AND n.id > ${schema.chatgptUsageSnapshots.id})))`,
        and(
          sql`${schema.chatgptUsageSnapshots.status} IN ('ok','rate_limited')`,
          sql`NOT EXISTS (SELECT 1 FROM chatgpt_usage_snapshots n WHERE n.account_id <=> ${schema.chatgptUsageSnapshots.accountId} AND n.status IN ('ok','rate_limited') AND (n.fetched_at > ${schema.chatgptUsageSnapshots.fetchedAt} OR (n.fetched_at = ${schema.chatgptUsageSnapshots.fetchedAt} AND n.id > ${schema.chatgptUsageSnapshots.id})))`,
        ),
      );
    case 'claudeUsageSnapshots':
      return or(
        sql`NOT EXISTS (SELECT 1 FROM claude_usage_snapshots n WHERE n.account_id <=> ${schema.claudeUsageSnapshots.accountId} AND n.id > ${schema.claudeUsageSnapshots.id})`,
        sql`NOT EXISTS (SELECT 1 FROM claude_usage_snapshots n WHERE n.account_id <=> ${schema.claudeUsageSnapshots.accountId} AND (n.fetched_at > ${schema.claudeUsageSnapshots.fetchedAt} OR (n.fetched_at = ${schema.claudeUsageSnapshots.fetchedAt} AND n.id > ${schema.claudeUsageSnapshots.id})))`,
      );
    case 'controlPlaneOutbox':
      return isNull(schema.controlPlaneOutbox.completedAt);
    case 'agentScopeEvents':
      return eq(schema.agentScopeEvents.dispatched, 0);
    case 'gitMergeRequests':
      return or(
        isNull(schema.gitMergeRequests.completedAt),
        sql`(SELECT COUNT(*) FROM git_merge_requests newer WHERE newer.clone_id = ${schema.gitMergeRequests.cloneId} AND (newer.requested_at > ${schema.gitMergeRequests.requestedAt} OR (newer.requested_at = ${schema.gitMergeRequests.requestedAt} AND newer.id > ${schema.gitMergeRequests.id}))) < 25`,
      );
    case 'workflowRunEvents':
      return sql`${schema.workflowRunEvents.type} = 'note.knowledge' AND JSON_EXTRACT(${schema.workflowRunEvents.detail}, '$.source.knowledge_id') IS NOT NULL AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = ${schema.workflowRunEvents.runId} AND r.status <> 'completed') AND NOT EXISTS (SELECT 1 FROM workflow_run_events n WHERE n.run_id = ${schema.workflowRunEvents.runId} AND n.type = 'note.knowledge' AND n.sequence > ${schema.workflowRunEvents.sequence} AND JSON_EXTRACT(n.detail,'$.source.knowledge_id') <=> JSON_EXTRACT(${schema.workflowRunEvents.detail},'$.source.knowledge_id') AND JSON_EXTRACT(n.detail,'$.task_id') <=> JSON_EXTRACT(${schema.workflowRunEvents.detail},'$.task_id') AND JSON_EXTRACT(n.actor,'$.address_id') <=> JSON_EXTRACT(${schema.workflowRunEvents.actor},'$.address_id') AND JSON_EXTRACT(n.actor,'$.session_id') <=> JSON_EXTRACT(${schema.workflowRunEvents.actor},'$.session_id') AND JSON_EXTRACT(n.actor,'$.binding_generation') <=> JSON_EXTRACT(${schema.workflowRunEvents.actor},'$.binding_generation'))`;
    case 'workflowTaskAttempts':
      return isNull(schema.workflowTaskAttempts.endedAt);
    // Sessions, identities, claims and grants are intentionally not filtered by
    // heartbeat or expiry: startup must reconcile their durable obligations.
    default:
      return undefined;
  }
}

export const STATE_INDEX_FIELDS = new Set([
  'name',
  'slug',
  'fqdn',
  'username',
  'email',
  'status',
  'state',
  'engine',
  'kind',
  'verdict',
  'credentialLookupHash',
  'apiKeyHash',
  'tokenHash',
  'keyHash',
  'credentialIdHash',
  'scopeKey',
  'repositoryKey',
  'challenge',
  'bridgeTokenHash',
  'requestId',
  'clientRequestId',
  'clientMessageId',
  'memoryKey',
]);
export function stateIndexFields(name: OwnedTableName): readonly string[] {
  return [
    ...Object.keys(stateColumns(name)).filter((key) => key.endsWith('Id') || STATE_INDEX_FIELDS.has(key)),
    ...(name === 'hosts' ? ['credentialLookupHash'] : []),
    ...(name === 'mcpSessionTokens' ? ['token'] : []),
  ];
}
