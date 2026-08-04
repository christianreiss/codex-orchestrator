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
 * prompting on every call — and nothing fails loudly. Importing the names here,
 * and unioning this array into `mcp-tool-name-liveness.test.ts`, turns that
 * silent drift into a build break.
 */
export const AGENT_MESSAGING_TOOLS = [
  'agent_list',
  'agent_send',
  'agent_request',
  'agent_wait',
  'agent_reply',
  'agent_message_get',
  'agent_cancel',
  'agent_call_open',
  'agent_call_join',
  'agent_listen',
] as const;
