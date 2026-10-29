import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName, isTable } from 'drizzle-orm';
import * as schema from '../../../src/db/schema.js';
import { currentSchemaColumns } from '../../fixtures/current-schema-columns.js';
import { loadMigrations } from '../../../src/db/migrator.js';

/** Migrations must update the current Drizzle mirror independently of the
 * bootstrap fixture. Fresh installs apply migrations after the frozen baseline;
 * the sibling schema check verifies that resulting projection against schema.ts.
 * Types/defaults/indexes remain the real-MySQL migration suite's responsibility. */

/** Anchored: a `CREATE TABLE` quoted inside a CALL argument is not a creation. */
const CREATE_TABLE = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_$]+)`?/i;
/** Unanchored: 0005 hides its ALTERs inside `CALL add_auth_generation_column(…)`. */
const ADD_COLUMN = /ALTER\s+TABLE\s+`?([A-Za-z0-9_$]+)`?\s+ADD\s+COLUMN\s+`?([A-Za-z0-9_$]+)`?/gi;
/**
 * Anchored, like `CREATE TABLE`: a drop quoted inside a CALL argument is not one.
 * The name list is captured whole because 0001 drops five tables in one
 * comma-separated statement.
 */
const DROP_TABLE = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`A-Za-z0-9_$,\s]+)/i;
/**
 * Unanchored, and matches the `CONCAT('ALTER TABLE `', tbl, '` DROP COLUMN …')`
 * form too: 0009 has to build its DDL as a string because MySQL has no
 * `DROP COLUMN IF EXISTS`, so the table name arrives via `CALL`.
 */
const DROP_COLUMN = /DROP\s+COLUMN\s+`?([A-Za-z0-9_$]+)`?/gi;
const DROP_COLUMN_CALL =
  /CALL\s+drop_[A-Za-z0-9_$]*column\s*\(\s*'([A-Za-z0-9_$]+)'\s*,\s*'([A-Za-z0-9_$]+)'\s*\)/gi;

interface Addition {
  migration: string;
  table: string;
  column?: string;
}

/**
 * Statements come from the production splitter, so comments are already gone —
 * the prose in 0003/0006 that quotes `CREATE TABLE IF NOT EXISTS` cannot be
 * mistaken for a real one.
 */
const migrationAdditions = async (): Promise<Addition[]> => {
  const additions: Addition[] = [];
  for (const file of await loadMigrations()) {
    for (const statement of file.statements) {
      const created = CREATE_TABLE.exec(statement);
      if (created) {
        additions.push({ migration: file.filename, table: created[1]! });
      }
      for (const [, table, column] of statement.matchAll(ADD_COLUMN)) {
        additions.push({ migration: file.filename, table: table!, column: column! });
      }
    }
  }
  return additions;
};

/**
 * The mirror image: what later migrations take back out. Without this, every
 * migration that drops something a *previous* migration added reads as an
 * addition `schema.ts` forgot — 0008 creates `agent_matrix_outbox` and 0009
 * drops it, and the baseline is right to contain neither.
 */
const migrationRemovals = async (): Promise<Set<string>> => {
  const removed = new Set<string>();
  for (const file of await loadMigrations()) {
    for (const statement of file.statements) {
      const dropped = DROP_TABLE.exec(statement);
      if (dropped) {
        for (const name of dropped[1]!.split(',')) {
          const table = name.trim().replaceAll('`', '');
          if (table) removed.add(table);
        }
      }
      for (const [, table, column] of statement.matchAll(DROP_COLUMN_CALL)) {
        removed.add(`${table}.${column}`);
      }
      // A direct `ALTER TABLE t DROP COLUMN c`, where the table is in the same
      // statement rather than passed to a procedure.
      const direct = /ALTER\s+TABLE\s+`?([A-Za-z0-9_$]+)`?/i.exec(statement);
      if (direct) {
        for (const [, column] of statement.matchAll(DROP_COLUMN)) {
          removed.add(`${direct[1]!}.${column}`);
        }
      }
    }
  }
  return removed;
};

describe('migrations against the test baseline', () => {
  it('adds no table or column missing from the current Drizzle mirror', async () => {
    const baseline = new Map<string, Set<string>>(
      Object.values(schema)
        .filter(isTable)
        .map((table) => [
          getTableName(table),
          new Set(Object.values(getTableColumns(table)).map((column) => column.name)),
        ] as const),
    );
    const retired = await migrationRemovals();
    const missing: string[] = [];

    for (const { migration, table, column } of await migrationAdditions()) {
      const columns = baseline.get(table);
      if (retired.has(table)) continue;
      if (column === undefined) {
        if (!columns) missing.push(`${migration}:${table}`);
        continue;
      }
      if (retired.has(`${table}.${column}`)) continue;
      if (!columns?.has(column)) missing.push(`${migration}:${table}.${column}`);
    }

    // Each entry reached migrations without the independently declared mirror.
    expect(missing).toEqual([]);
  });

  // Pins the removal extraction the same way: a regex that stops matching here
  // would make the check above start reporting retired schema as drift.
  it('reads the tables and columns the shipped migrations actually remove', async () => {
    expect([...(await migrationRemovals())].sort()).toEqual([
      'agent_bus_addresses.call_pin',
      'agent_bus_addresses.call_pin_expires_at',
      'agent_matrix_outbox',
      'agent_portal_browser_sessions',
      'agent_portal_users',
      'agent_portal_users.matrix_room',
      'claude_usage_snapshots',
      'dashboard_graph_claude_daily_stats',
      'dashboard_graph_usage_daily_stats',
      'hosts.config_baked_at',
      'ip_rate_limits',
      'mcp_access_logs_retired',
      'openai_api_keys.rate_limit_rpm',
      'secrets.engine',
      'token_usage_ingests',
      'token_usages',
    ]);
  });

  // Pins the extraction itself, so a regex that quietly stops matching cannot
  // turn the check above into a test of an empty list.
  it('reads the tables and columns the shipped migrations actually add', async () => {
    const additions = await migrationAdditions();

    expect(additions.filter((a) => a.column === undefined).map((a) => a.table)).toEqual([
      'coord_project_memories',
      'claude_artifacts',
      'auth_canonical_heads',
      'shared_memories',
      'shared_memory_chunks',
      'shared_memory_revisions',
      'skill_files',
      'agent_portal_users',
      'agent_portal_browser_sessions',
      'agent_sessions',
      'agent_events',
      'agent_prompts',
      'agent_messages',
      'agent_matrix_outbox',
      'secrets',
      'agent_bus_addresses',
      'agent_bus_conversations',
      'agent_bus_messages',
      'agent_bus_relays',
      'agent_policy_profiles',
      'agent_policy_profile_assignments',
      'agent_bus_conferences',
      'agent_bus_conference_members',
      'claude_usage_snapshots',
      'git_clones',
      'git_worktrees',
      'git_merge_requests',
      'coord_project_boards',
      'coord_project_board_columns',
      'coord_project_cards',
      'agent_transfers',
      'agent_transfer_events',
      'coord_project_card_deps',
      'provider_accounts',
      'provider_account_sessions',
      'grok_auth_refresh_state',
      'companion_pairings',
      'companion_devices',
      'companion_follows',
      'companion_notifications',
      'grok_usage_snapshots',
      'agent_bus_groups',
      'agent_bus_subscriptions',
      'agent_bus_publications',
      'agent_schedules',
      'agent_schedule_runs',
      'agent_task_results',
      'agent_fresh_start_grants',
      'agent_name_pool',
      'agent_name_leases',
      'agent_watchdogs',
      'host_daemons',
      'host_daemon_sessions',
      'host_daemon_operations',
      'chatty_sessions',
      'chatty_runs',
      'chatty_events',
      'chatty_actions',
      'host_daemon_portal_bindings',
      'companion_daemon_follows',
      'session_housekeeping_reservations',
      'agent_reboot_handoffs',
      'host_spawns',
      'agent_chat_attachments',
      'agent_chat_notices',
      'feedback_items',
      'feedback_events',
      'engine_destroy_hosts',
      'advisor_sessions',
      'agent_resource_claims',
      'agent_scope_bindings',
      'agent_scope_events',
      'agent_scope_members',
      'agent_scopes',
      'agent_room_events',
      'agent_room_reads',
      'agent_room_operations',
      'agent_room_deliveries',
      'agent_roles',
      'agent_role_versions',
      'agent_role_blobs',
      'agent_role_version_files',
      'agent_role_assignments',
      'agent_role_proposals',
      'agent_role_proposal_events',
      'workflow_mutations',
      'workflow_run_evaluations',
      'workflow_run_events',
      'workflow_run_invitations',
      'workflow_run_members',
      'workflow_run_tasks',
      'workflow_runs',
      'workflow_task_attempts',
      'workflow_versions',
      'workflows',
      'feedback_pipeline',
      'control_plane_owner',
      'control_plane_command_receipts',
      'control_plane_outbox',
      'agent_room_agent_reads',
      'companion_reads',
      'agent_work_states',
      'agent_work_dependencies',
      'agent_room_changes',
      'companion_room_prefs',
    ]);
    expect(additions.filter((a) => a.column !== undefined).map((a) => `${a.table}.${a.column}`)).toEqual([
      'auth_payloads.generation',
      'auth_payloads.source_kind',
      'auth_payloads.parent_payload_id',
      'auth_payloads.credential_kind',
      'auth_payloads.fingerprint_kid',
      'auth_payloads.access_fingerprint',
      'auth_payloads.refresh_fingerprint',
      'auth_payloads.pair_fingerprint',
      'auth_payloads.credential_issued_at',
      'auth_payloads.access_expires_at',
      'auth_payloads.refresh_expires_at',
      'auth_payloads.superseded_at',
      'auth_payloads.purge_after',
      'skills.source_type',
      'skills.source_repository',
      'skills.source_path',
      'skills.source_revision',
      'skills.source_license',
      'skills.bundle_sha256',
      'shared_memory_revisions.prev_content',
      'secrets.source_host_id',
      'secrets.source_engine',
      'hosts.agent_messaging_enabled',
      'agent_bus_messages.dispatch_order',
      'agent_sessions.agent_bus_address_id',
      'agent_sessions.adapter_protocol',
      'agent_sessions.adapter_capabilities',
      'agent_sessions.receive_heartbeat_at',
      'agent_sessions.binding_generation',
      'agent_sessions.close_requested_at',
      'agents_documents.builder_state',
      'agent_bus_addresses.call_pin',
      'agent_bus_addresses.call_pin_expires_at',
      'agent_messages.admin_user_id',
      'agent_transfer_events.seq',
      'agent_sessions.receiver',
      'coord_project_files.content_encoding',
      'coord_project_cards.due_at',
      'auth_payloads.account_id',
      'chatgpt_usage_snapshots.account_id',
      'claude_usage_snapshots.account_id',
      'auth_seed_tokens.account_id',
      'provider_accounts.merged_into_account_id',
      'hosts.grok_client_version',
      'hosts.grok_client_version_override',
      'hosts.grok_wrapper_version',
      'hosts.grok_auth_digest',
      'hosts.grok_model_override',
      'hosts.grok_reasoning_effort_override',
      'hosts.grok_last_refresh',
      'agent_bus_messages.execution_contract_version',
      'agent_bus_messages.work_kind',
      'agent_bus_messages.task_result_status',
      'agent_bus_messages.execution_version',
      'agent_schedules.max_recovery_attempts',
      'agent_schedules.pause_reason',
      'agent_schedule_runs.max_recovery_attempts',
      'agent_schedule_runs.warning_at',
      'agent_sessions.launch_name',
      'agent_bus_addresses.launch_name',
      'agent_bus_messages.sender_name',
      'agent_bus_messages.target_name',
      'agent_bus_messages.requested_target',
      'agent_bus_conference_members.launch_name',
      'agent_bus_conference_members.requested_target',
      'agent_bus_messages.target_session_id',
      'agent_bus_messages.presence_notice_key',
      'agent_bus_messages.awaiting_presence',
      'host_daemon_operations.portal_content_enc',
      'hosts.insecure_session_renewal_blocked',
      'agent_prompts.answer_mode',
      'agent_prompts.choices_enc',
      'agent_messages.metadata_enc',
      'agent_sessions.workspace',
      'agent_sessions.activity',
      'hosts.wrapper_canary',
      'openai_api_keys.backend_engine',
      'agent_bus_messages.delivery_class',
      'agent_bus_messages.coalesce_key',
      'agent_bus_messages.related_work_id',
      'agent_bus_messages.event_count',
      'agent_bus_messages.event_first_at',
      'agent_bus_messages.event_last_at',
      'agent_bus_messages.digest_id',
      'agent_bus_messages.superseded_by_id',
      'agent_bus_messages.presented_at',
      'grok_usage_snapshots.plan_name',
      'grok_usage_snapshots.plan_fetched_at',
      'grok_usage_snapshots.plan_error_code',
      'git_worktrees.head_observed_at',
      'agent_transfers.expected_size_bytes',
      'agent_transfers.expected_sha256',
      'hosts.internal_role',
      'host_daemon_sessions.model',
      'agent_bus_conferences.owner_admin_id',
      'hosts.last_contact_at',
      'agent_sessions.provider_account_id',
      'agent_watchdogs.quota_account_id',
      'agent_watchdogs.quota_window',
      'agent_watchdogs.quota_reset_at',
      'agent_watchdogs.quota_attempts',
      'agent_watchdogs.quota_attempt_at',
      'agent_schedule_runs.quota_recovery',
      'workflow_runs.preparation',
      'git_worktrees.agent_session_id',
      'git_worktrees.agent_binding_generation',
      'git_merge_requests.reported_outcome',
      'git_merge_requests.reported_target_head_sha',
      'git_merge_requests.outcome_reported_at',
      'provider_account_sessions.ownership_mode',
      'agent_resource_claims.native_instance_id',
      'agent_resource_claims.ownership_mode',
      'agent_resource_claims.uncertainty_reason',
      'git_worktrees.native_instance_id',
      'git_worktrees.ownership_mode',
      'git_worktrees.uncertainty_reason',
      'agent_bus_messages.ownership_mode',
      'agent_bus_messages.owner_instance_id',
      'coord_project_cards.claim_ownership_mode',
      'coord_project_cards.claim_session_id',
      'coord_project_cards.claim_binding_generation',
      'coord_project_cards.claim_native_instance_id',
      'coord_project_cards.claim_uncertainty_reason',
      'agent_messages.ownership_mode',
      'agent_messages.owner_instance_id',
      'agent_messages.owner_binding_generation',
      'workflow_runs.coordinator_ownership_mode',
      'workflow_runs.coordinator_session_id',
      'workflow_runs.coordinator_binding_generation',
      'workflow_runs.coordinator_native_instance_id',
      'workflow_run_tasks.claim_ownership_mode',
      'workflow_run_tasks.claim_native_instance_id',
      'control_plane_command_receipts.replay_class',
      'control_plane_command_receipts.result_state',
      'agent_bus_messages.delivery_timing',
      'companion_pairings.device_id',
      'companion_devices.read_sync_protocol',
      'agent_bus_conferences.rendezvous_key',
      'companion_devices.room_change_cursor',
      'host_daemon_sessions.permission_mode',
    ]);
  });

  it('reads whole tables out of the baseline, columns and all', () => {
    const baseline = currentSchemaColumns();
    expect(baseline.get('auth_canonical_heads')).toEqual(
      new Set(['engine', 'payload_id', 'generation', 'updated_at']),
    );
    expect(baseline.get('schema_migrations')?.has('checksum')).toBe(true);
    expect(baseline.get('agent_bus_messages')?.has('delivery_timing')).toBe(true);
  });
});
