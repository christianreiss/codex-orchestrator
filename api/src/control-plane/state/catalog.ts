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
  companionReads: 'owned',
  companionFollows: 'owned',
  companionRoomPrefs: 'owned',
  companionNotifications: 'owned',
  agentSchedules: 'owned',
  agentScheduleRuns: 'owned',
  agentTaskResults: 'owned',
  agentFreshStartGrants: 'owned',
  agentWatchdogs: 'owned',
  agentWorkStates: 'owned',
  agentWorkDependencies: 'owned',
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
  agentRoomChanges: 'cold',
  agentRoomAgentReads: 'cold',
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
                                    portalAcceptedAt: string | null;
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
        eq(schema.agentBusMessages.taskResultStatus, 'unknown'),
        and(
          eq(schema.agentBusMessages.status, 'expired'),
          sql`${schema.agentBusMessages.expiredAt} > ${new Date(Date.now() - AGENT_MESSAGING_MISSED_WINDOW_SECONDS * 1000).toISOString()}`,
        ),
        // UNION prevents derived-table merging: compute dependency IDs once,
        // rather than executing each correlated lookup for every history row.
        sql`BINARY ${schema.agentBusMessages.id} IN (
          SELECT id FROM (
            SELECT BINARY child.digest_id AS id FROM agent_bus_messages child
              WHERE child.digest_id IS NOT NULL AND child.status = 'batched'
            UNION
            SELECT BINARY reply.reply_to_message_id FROM agent_bus_messages reply
              WHERE reply.reply_to_message_id IS NOT NULL
                AND reply.status NOT IN ('completed','delivered','digested','dead','expired','canceled','superseded')
            UNION
            SELECT BINARY dependent.related_work_id FROM agent_bus_messages dependent
              WHERE dependent.related_work_id IS NOT NULL
                AND dependent.status IN ('queued','leased','accepted','batched','reboot_hold')
            UNION
            SELECT BINARY r.message_id FROM agent_schedule_runs r
              WHERE r.message_id IS NOT NULL AND r.status IN ('waiting','queued','leased','accepted','recovering','capacity_wait')
            UNION
            SELECT BINARY edge.message_id FROM agent_work_dependencies edge WHERE edge.message_id IS NOT NULL AND edge.status IN ('waiting','attention')
            UNION
            SELECT BINARY dependent.waiting_for_message_id FROM agent_work_states dependent WHERE dependent.waiting_for_message_id IS NOT NULL AND dependent.state='waiting_agent'
            UNION
            SELECT BINARY w.message_id FROM agent_watchdogs w
              WHERE w.message_id IS NOT NULL AND w.status IN ('watching','recovering','capacity_wait')
            UNION
            SELECT BINARY notice.id FROM agent_bus_messages notice
              JOIN agent_sessions recipient ON recipient.id = BINARY SUBSTRING_INDEX(notice.presence_notice_key, ':', 1)
              JOIN agent_sessions sender ON sender.id = BINARY notice.target_session_id
              WHERE notice.presence_notice_key IS NOT NULL AND recipient.ended_at IS NULL AND sender.ended_at IS NULL
          ) retained_message_ids
        )`,
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
          sql`BINARY ${schema.agentBusMessages.id} IN (
            SELECT id FROM (
              SELECT DISTINCT BINARY d.message_id AS id FROM agent_room_deliveries d
                JOIN agent_room_events e ON e.id = BINARY d.event_id
                JOIN agent_bus_conferences c ON c.id = BINARY e.room_id
                WHERE d.message_id IS NOT NULL AND c.status <> 'adjourned'
            ) conference_message_ids
          )`,
        ),
      );
    case 'agentRoomEvents':
      return undefined; // Small history metadata supplies RAM-only retention decisions; bodies stay cold.
    case 'agentRoomDeliveries':
      return sql`EXISTS (SELECT 1 FROM agent_bus_messages m WHERE BINARY m.id=BINARY ${schema.agentRoomDeliveries.messageId} AND (m.status IN ('queued','leased','accepted','reboot_hold','batched','ambiguous') OR m.task_result_status='unknown')) OR EXISTS (SELECT 1 FROM agent_room_events e JOIN agent_bus_conferences c ON BINARY c.id = BINARY e.room_id JOIN agent_bus_messages m ON BINARY m.id = BINARY ${schema.agentRoomDeliveries.messageId} WHERE BINARY e.id = BINARY ${schema.agentRoomDeliveries.eventId} AND c.status <> 'adjourned' AND m.sender_address_id = '00000000-0000-4000-8000-000000000001' AND m.status NOT IN ('completed','dead','expired','canceled','ambiguous'))`;
    case 'chatgptUsageSnapshots':
      // Rank each account (including NULL) once per required ordering, rather
      // than re-scanning its entire history for every candidate snapshot.
      return sql`${schema.chatgptUsageSnapshots.id} IN (
        SELECT id FROM (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY id DESC) AS by_id,
            ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY fetched_at DESC, id DESC) AS by_fetched
          FROM chatgpt_usage_snapshots
        ) latest WHERE by_id = 1 OR by_fetched = 1
        UNION
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY fetched_at DESC, id DESC) AS position
          FROM chatgpt_usage_snapshots WHERE status IN ('ok','rate_limited')
        ) usable WHERE position = 1
        UNION
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY fetched_at ASC, id ASC) AS position
          FROM chatgpt_usage_snapshots
          WHERE fetched_at >= DATE_FORMAT(UTC_DATE(), '%Y-%m-%dT00:00:00.000Z')
            AND status IN ('ok','rate_limited')
            AND ((primary_limit_seconds = 604800 AND primary_used_percent IS NOT NULL)
              OR (secondary_limit_seconds = 604800 AND secondary_used_percent IS NOT NULL))
        ) daily WHERE position = 1
        ) selected_ids
      )`;
    case 'claudeUsageSnapshots':
      return sql`${schema.claudeUsageSnapshots.id} IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY id DESC) AS by_id,
            ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY fetched_at DESC, id DESC) AS by_fetched
          FROM claude_usage_snapshots
        ) latest WHERE by_id = 1 OR by_fetched = 1
      )`;
    case 'controlPlaneOutbox':
      return isNull(schema.controlPlaneOutbox.completedAt);
    case 'agentScopeEvents':
      return undefined;
    case 'gitMergeRequests':
      return or(
        isNull(schema.gitMergeRequests.completedAt),
        sql`(SELECT COUNT(*) FROM git_merge_requests newer WHERE newer.clone_id = ${schema.gitMergeRequests.cloneId} AND (newer.requested_at > ${schema.gitMergeRequests.requestedAt} OR (newer.requested_at = ${schema.gitMergeRequests.requestedAt} AND newer.id > ${schema.gitMergeRequests.id}))) < 25`,
      );
    case 'workflowRunEvents':
      return sql`${schema.workflowRunEvents.type} = 'note.knowledge' AND JSON_EXTRACT(${schema.workflowRunEvents.detail}, '$.source.knowledge_id') IS NOT NULL AND EXISTS (SELECT 1 FROM workflow_runs r WHERE BINARY r.id = BINARY ${schema.workflowRunEvents.runId} AND r.status <> 'completed') AND NOT EXISTS (SELECT 1 FROM workflow_run_events n WHERE n.run_id = ${schema.workflowRunEvents.runId} AND n.type = 'note.knowledge' AND n.sequence > ${schema.workflowRunEvents.sequence} AND JSON_EXTRACT(n.detail,'$.source.knowledge_id') <=> JSON_EXTRACT(${schema.workflowRunEvents.detail},'$.source.knowledge_id') AND JSON_EXTRACT(n.detail,'$.task_id') <=> JSON_EXTRACT(${schema.workflowRunEvents.detail},'$.task_id') AND JSON_EXTRACT(n.actor,'$.address_id') <=> JSON_EXTRACT(${schema.workflowRunEvents.actor},'$.address_id') AND JSON_EXTRACT(n.actor,'$.session_id') <=> JSON_EXTRACT(${schema.workflowRunEvents.actor},'$.session_id') AND JSON_EXTRACT(n.actor,'$.binding_generation') <=> JSON_EXTRACT(${schema.workflowRunEvents.actor},'$.binding_generation'))`;
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
