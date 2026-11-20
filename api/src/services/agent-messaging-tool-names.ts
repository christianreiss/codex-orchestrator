/**
 * The peer-messaging tool names, in one place.
 *
 * These are served by the `cxx-agent` stdio MCP server (`cxx agent mcp`), which
 * the wrapper starts itself. They are deliberately NOT in `McpToolsRegistry` —
 * that registry describes the orchestrator's own `clx` server, a different
 * process on a different transport.
 *
 * Three places name these tools: the Claude permission allowlist baked into
 * managed settings (`client-config.ts`), the managed Agent Messaging block in
 * every served AGENTS.md / CLAUDE.md (`managed-agents-features.ts`), and the
 * server itself. A rename that misses one of them leaves the fleet with
 * instructions pointing at a tool that no longer answers, or an unapproved tool
 * prompting on every call — and nothing fails loudly.
 *
 * This array is the whole catalogue the wrapper serves, not only the tools the
 * managed block names: `test/unit/contract/cxx-agent-tool-catalog.test.ts`
 * holds it equal to the `tool(...)` definitions in
 * `wrappers/cxx/internal/agentbus/`, so a tool added there without an entry
 * here (and so without a permission rule) fails the API suite.
 * `mcp-tool-name-liveness.test.ts` unions it into the live set and checks
 * that the managed block names every entry, verbatim or as its family, apart
 * from `MANAGED_BLOCK_UNNAMED_TOOLS`.
 */
export const AGENT_MESSAGING_TOOLS = [
  'quota_get',
  'host_insecure_enable',
  'agent_spawn',
  'agent_spawn_status',
  'agent_stop',
  'advisor_ask',
  'advisor_close',
  'advisor_status',
  'watchdog_get',
  'watchdog_enable',
  'watchdog_disable',
  'watchdog_finish',
  'agent_session_name',
  'agent_self',
  'agent_work_state',
  'agent_context_get',
  'agent_context_update',
  'agent_chat_list',
  'agent_chat_read',
  'agent_chat_send',
  'agent_room_list',
  'agent_room_read',
  'agent_room_send',
  'resource_claim_acquire',
  'resource_claim_status',
  'resource_claim_release',
  'agent_reboot',
  'agent_reboot_status',
  'agent_translate',
  'agent_list',
  'agent_send',
  'agent_request',
  'agent_wait',
  'agent_reply',
  'agent_task_result',
  'agent_receiver_reply',
  'agent_receiver_status',
  'agent_portal_say',
  'agent_portal_ask',
  'agent_portal_notify',
  'agent_portal_resolve',
  'agent_attachment_upload',
  'agent_attachment_get',
  'agent_message_get',
  'agent_digest_get',
  'agent_cancel',
  'agent_listen',
  'agent_conf_open',
  'agent_conf_invite',
  'agent_conf_join',
  'agent_conf_roster',
  'agent_conf_list',
  'agent_conf_say',
  'agent_conf_dispatch',
  'agent_conf_adjourn',
  'agent_group_list',
  'agent_group_create',
  'agent_group_members',
  'agent_group_delete',
  'agent_subscribe',
  'agent_unsubscribe',
  'agent_subscriptions',
  'agent_publish',
  'agent_role_activate',
  'agent_role_current',
  'agent_role_release',
  'agent_role_propose',
  'agent_role_proposals',
  'agent_role_review',
  'agent_accept',
  'agent_git_remote',
  // Named by the Workflows section as the `agent_workflow_*` family.
  'agent_workflow_create',
  'agent_workflow_revise',
  'agent_workflow_archive',
  'agent_workflow_run_create',
  'agent_workflow_run_current',
  'agent_workflow_run_control',
  'agent_workflow_run_note',
  'agent_workflow_run_evaluate',
  'agent_workflow_run_finish',
  'agent_workflow_invite',
  'agent_workflow_membership',
  'agent_workflow_task_claim',
  'agent_workflow_task_update',
] as const;

export type AgentMessagingTool = (typeof AGENT_MESSAGING_TOOLS)[number];

/**
 * Served tools the managed block deliberately does not name, with the reason.
 * Every word of that block is paid on every turn of every agent, so a tool
 * whose own MCP description carries its whole procedure stays out of it.
 * They are still approved in the Claude allowlist like every other entry.
 */
export const MANAGED_BLOCK_UNNAMED_TOOLS: Partial<Record<AgentMessagingTool, string>> = {
  agent_accept:
    'explicit adoption of an already read queued request; its MCP description and docs/interface-cdx.md carry the procedure',
  agent_git_remote:
    'Git Director bookkeeping for an SSH checkout; its MCP description and docs/agent-coordination.md carry the procedure',
};

/**
 * The MCP server name Claude Code sees for the messaging server.
 *
 * On Codex the wrapper's managed config names the stdio server `cxx-agent`
 * directly. On Claude it is provided by the per-launch `cxx-receiver` plugin
 * instead (that is the only shape that may declare the `claude/channel`
 * capability without the `--dangerously-load-development-channels`
 * confirmation), and Claude Code keys a plugin-provided server as
 * `plugin:<plugin>:<server>`, normalising `:` to `_` when it builds the
 * `mcp__<server>__<tool>` identifier permissions match on.
 *
 * Renaming the plugin or the server inside it renames every tool: keep this in
 * step with `ClaudeReceiverArgs` in `wrappers/cxx/internal/agentportal/receiver.go`.
 */
export const CLAUDE_AGENT_MESSAGING_SERVER = 'plugin_cxx-receiver_cxx-agent';

/**
 * The server name a Claude host sees while it still runs a wrapper that passes
 * `cxx-agent` as an ordinary user-scope MCP entry rather than inside the
 * plugin. Kept so config served to a host that has not self-updated yet still
 * matches the tools that host actually has; see
 * `claudeMessagingServerFor` in `client-config.ts`.
 */
export const LEGACY_CLAUDE_AGENT_MESSAGING_SERVER = 'cxx-agent';
