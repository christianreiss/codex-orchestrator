/** Exact 0.164.0 field paths; map identifiers are never interpreted as paths. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const newFeatures = ['app_server_websocket_compression', 'executor_capability_discovery_v2',
  'mcp_tool_list_changed', 'multi_env_copy_file', 'runtime_agent_instances',
  'subagent_thread_environments', 'wake_on_agent_messages'];

export function needsCodex164(value: Record<string, unknown>): boolean {
  const tui = record(value.tui);
  if (newFeatures.some(key => Object.hasOwn(record(value.features), key))
    || Object.hasOwn(tui, 'presets')
    || Object.hasOwn(record(record(tui.keymap).chat), 'open_presets')
    || ['PreModelRequest', 'PostModelRequest'].some(key => Object.hasOwn(record(value.hooks), key))
    || Object.values(record(record(value.hooks).state)).some(state => Object.hasOwn(record(state), 'trusted_content_hash'))
    || Object.values(record(value.plugins)).some(plugin => ['remote_plugin_id', 'release_id', 'auto_provision'].some(key => Object.hasOwn(record(plugin), key)))) return true;
  const servers = Array.isArray(value.mcp_servers) ? value.mcp_servers : Object.values(record(value.mcp_servers));
  if (servers.some(server => Object.hasOwn(record(record(server).oauth), 'token_endpoint_auth_method'))) return true;
  const idp = record(record(value.mcp_enterprise_managed_auth).idp);
  if (['client_secret', 'token_endpoint_auth_method'].some(key => Object.hasOwn(idp, key))) return true;
  return Object.values(record(value.permissions)).some(profile => {
    const mitm = record(record(record(profile).network).mitm);
    return Object.hasOwn(mitm, 'version')
      || Object.values(record(mitm.hooks)).some(hook => ['ports', 'schemes'].some(key => Object.hasOwn(record(hook), key)))
      || Object.values(record(mitm.actions)).some(action => {
        const headers = record(action).inject_request_headers;
        return Array.isArray(headers) && headers.some(header => Object.hasOwn(record(header), 'placeholder'));
      });
  });
}
