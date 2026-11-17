/** Exact 0.164.0–0.169.0 field paths; map identifiers are never interpreted as paths. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const features165 = ['guardian_recorded_items', 'guardianv3', 'prediction_preserve_parent_tools', 'tui_multi_backend'];

/** The built-in `gcp` provider is new in 0.165.0. A `model_providers.gcp` entry
 * stays opaque (its 0.165 field limits are enforced for every version instead). */
export function needsCodex165(value: Record<string, unknown>): boolean {
  return features165.some(key => Object.hasOwn(record(value.features), key))
    || Object.hasOwn(record(value.auto_review), 'timeout_ms')
    || value.model_provider === 'gcp';
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

/** New 0.166 fields only; provider/action identifiers remain opaque segments. */
export function needsCodex166(value: Record<string, unknown>): boolean {
  const features = record(value.features);
  return ['critical_path_timing', 'guardian_native_multi_agent_history', 'mcp_connection_sharing',
    'omit_skill_descriptions', 'simplified_selection_hints',
    'skill_catalog_deltas', 'untrusted_as_tool_output'].some(key => Object.hasOwn(features, key))
    || Object.hasOwn(record(features.rollout_budget), 'enforce_limit')
    || Object.hasOwn(record(value.memories), 'consolidation_service_tier')
    || Object.hasOwn(record(record(record(value.tui).keymap).global), 'select_transcript')
    || Object.entries(record(value.model_providers)).some(([id, provider]) =>
      ['project_id', 'location', 'credential_file'].some(key => Object.hasOwn(record(provider), key))
      || (id === 'openai' && Object.hasOwn(record(provider), 'model_catalog_url')))
    || Object.values(record(value.permissions)).some(profile =>
      Object.values(record(record(record(record(profile).network).mitm).actions))
        .some(action => ['aws_sigv4', 'body_secret_substitution'].some(key => Object.hasOwn(record(action), key))));
}

/** New 0.167 fields only; provider/plugin/connector identifiers remain opaque segments. */
export function needsCodex167(value: Record<string, unknown>): boolean {
  return ['apps_early_resource_discovery', 'code_mode_host_output_truncation', 'gcp_setup_wizard',
    'incremental_exec_tools', 'interrupt_on_cancel', 'suppress_model_change_announcements',
    'tui_extensions_statusline'].some(key => Object.hasOwn(record(value.features), key))
    || Object.hasOwn(record(value.otel), 'log_sse_deltas')
    || Object.values(record(value.model_providers)).some(provider =>
      Object.hasOwn(record(record(provider).gateway_oauth), 'credentials_store')
      || Object.hasOwn(record(record(provider).capabilities), 'cyber_access_programs'))
    || Object.values(record(value.plugins)).some(plugin => Object.hasOwn(record(plugin), 'apps'));
}

const features168 = ['agent_message_board_mcp', 'async_compaction_root_only', 'cli_resume_account_check',
  'command_sessions_world_state', 'guardian_denial_reconsideration', 'guardian_include_additional_context',
  'hosted_search_policy', 'image_generation_animation', 'tui_workspace'];
const paneBindings168 = ['change_host', 'equalize_pane_widths', 'focus_main_composer', 'focus_pane_left',
  'focus_pane_right', 'focus_sidebar_content', 'hide_pane', 'maximize_pane_width', 'minimize_pane_width',
  'move_divider_left', 'move_divider_right', 'resize_panes', 'toggle_pane_zoom'];

export function needsCodex168(value: Record<string, unknown>): boolean {
  const tui = record(value.tui), guardian = record(record(value.features).guardianv2);
  return features168.some(key => Object.hasOwn(record(value.features), key))
    || ['default_hosts', 'sidebar_width_percent'].some(key => Object.hasOwn(tui, key))
    || tui.notification_method === 'osc777'
    || paneBindings168.some(key => Object.hasOwn(record(record(tui.keymap).global), key))
    || Object.hasOwn(record(value.tools), 'client_search_provider')
    || ['sync_elastic_budgeting', 'sync_elastic_sections'].some(key => Object.hasOwn(guardian, key));
}

/** The legacy incremental flags disappeared in 0.168 and returned in 0.169.
 * Conservatively require 0.169 for newly authored use, never infer monotonic
 * support from their brief 0.167.1/0.167.2 appearance. */
export function needsCodex169(value: Record<string, unknown>): boolean {
  return ['daybreak_program_propagation', 'gateway_setup_wizard', 'incremental_tools_legacy',
    'incremental_tools_legacy_gcp', 'mcp_lazy_stdio_startup'].some(key => Object.hasOwn(record(value.features), key))
    || Object.hasOwn(record(value.tui), 'collapse_turn_details')
    || ['close_sidebar_tab', 'focus_sidebar_tabs', 'sidebar_down', 'sidebar_up']
      .some(key => Object.hasOwn(record(record(record(value.tui).keymap).global), key))
    || Object.values(record(value.model_providers)).some(provider => {
      const oauth = record(record(provider).gateway_oauth);
      return ['device_authorization_url', 'credential_export'].some(key => Object.hasOwn(oauth, key));
    });
}
