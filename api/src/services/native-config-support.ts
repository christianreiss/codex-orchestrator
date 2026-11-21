import { kimiNativeMinimum } from './kimi-native-settings.js';
import { GROK_188_FEATURES, GROK_188_UI_FIELDS, GROK_188_MODEL_FIELDS, GROK_189_FEATURES, GROK_189_CONTEXTUAL_HINTS } from './grok-native-fields.js';
import { needsCodex164, needsCodex165, needsCodex166, needsCodex167, needsCodex168, needsCodex169, needsCodex170, needsCodex171 } from './codex-native-capabilities.js';
import type { Host } from '../db/schema.js';
import { ValidationError } from '../http/errors.js';
import type { Engine } from '../util/engine.js';
import { versionCompare } from './wrapper-bin-registry.js';

/** Audited native schemas are a capability baseline, not a universal CLI floor. */
export const NATIVE_CONFIG_MIN_VERSIONS = { codex: '0.162.1', claude: '2.1.296' } as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const codex163Features = [
  'async_compaction', 'code_mode_host_grpc',
  'credential_masking', 'guardian_trust_orchestrator_connectors', 'output_token_replay',
  'retain_client_tool_outputs', 'subagent_default_context_limits',
];
const codex163Voices = new Set([
  'aube', 'bubbie', 'haetsal', 'hanul', 'himari', 'leher', 'miko', 'neer',
  'porto', 'rindo', 'rio', 'rivage', 'selva', 'sonna', 'tinta', 'viola',
]);

/** Exact field paths only: plugin/MCP ids and dotted map keys are opaque. */
function needsCodex163(value: Record<string, unknown>): boolean {
  const features = record(value.features);
  const multiAgent = record(features.multi_agent_v2);
  return Object.hasOwn(value, 'include_environment_context_time')
    || codex163Features.some(key => Object.hasOwn(features, key))
    || ['disable_native_tools', 'preserve_fork_prefix'].some(key => Object.hasOwn(multiAgent, key))
    || Object.hasOwn(record(value.plugins), '_default')
    || Object.hasOwn(record(value.tui), 'copy_on_select_clear_selection')
    || Object.hasOwn(record(record(record(value.tui).keymap).global), 'leader')
    || Object.hasOwn(record(value.windows), 'allow_mxc')
    || Object.hasOwn(record(value.notice), 'hide_gov_cloud_guidance')
    || codex163Voices.has(String(record(value.realtime).voice));
}

/** Audit additions only; Grok's existing installer floor remains 1.0.50. */
function grokNativeMinimum(native: Record<string, unknown>, observed?: string, includeOverrides = true): string | null {
  let minimum: string | null = null;
  const require = (version: string) => { if (!minimum || versionCompare(version, minimum) > 0) minimum = version; };
  const has = (root: Record<string, unknown>, key: string) => Object.hasOwn(root, key);
  const features = record(native.features);
  const ui = record(native.ui);
  if (has(record(native.keys), 'vim')) require(record(native.keys).vim === 'all' ? '1.0.71' : '1.0.68');
  if (has(features, 'worktree_inherits_main_approvals')) require('1.0.67');
  if (has(record(ui.notifications), 'program_status')) require('1.0.63');
  for (const groups of Object.values(record(native.hooks))) {
    if (Array.isArray(groups)) for (const group of groups) {
      const handlers = record(group).hooks;
      if (Array.isArray(handlers) && handlers.some(handler => has(record(handler), 'args'))) require('1.0.63');
      if (Array.isArray(handlers) && handlers.some(handler => has(record(handler), 'failClosed'))) require('1.0.71');
    }
  }
  if (['ask_answer_rows', 'cursor_marketplace', 'subagent_bundle', 'workflow_conversion', 'workspace_dashboard'].some(key => has(features, key))
    || has(record(native.diagnostics), 'error_reporting') || has(record(native.endpoints), 'web_base_url')
    || has(record(native.memory_v2), 'daily_token_cap')) require('1.0.70');
  for (const model of Object.values(record(native.model))) {
    const fields = record(model);
    if (has(fields, 'vision') || has(fields, 'compactions_remaining') || has(fields, 'send_compactions_remaining') || typeof fields.compaction_at_tokens === 'boolean') require('1.0.70');
    if (has(fields, 'supports_reasoning_text_replay')) require('1.0.90');
    if (has(fields, 'interjection_reply_nudge')) require('1.0.74');
  }
  for (const tool of ['image_gen', 'video_gen']) {
    const fields = record(record(native.toolset)[tool]);
    if (has(fields, 'base_url') || has(fields, 'env_key')) require('1.0.70');
  }
  // 1.0.71–1.0.77 additions; first releases per the 2026-11-06 bundled-reference audit.
  if (has(features, 'send_feedback_tool') || has(ui, 'single_ctrl_c_quit')) require('1.0.71');
  if (has(record(native.managed_mcps), 'allow_external_auth') || has(ui, 'multiline_default')) require('1.0.73');
  if (has(features, 'request_compression') || has(features, 'resume_pagination')
    || has(ui, 'at_picker_outside_workspace') || has(record(native.workflows), 'runtime')) require('1.0.74');
  if (has(features, 'daemon_feedback_drafts')) require('1.0.76');
  if (has(ui, 'kitty_keyboard')) require('1.0.77');
  // Newly audited in 1.0.88, conservatively gated without guessing an earlier release.
  if (has(native, 'env') || GROK_188_FEATURES.some(key => has(features, key))
    || GROK_188_UI_FIELDS.some(key => has(ui, key))
    || has(record(native.telemetry), 'otel_shutdown_timeout')
    || Object.values(record(native.model)).some(value => GROK_188_MODEL_FIELDS.some(key => has(record(value), key)))
    || Object.values(record(native.mcp_servers)).some(value => has(record(value), 'headers_helper'))) require('1.0.88');
  // 1.0.89 additions: 1.0.88 reports all four as unrecognized config keys.
  if (GROK_189_FEATURES.some(key => has(features, key))
    || GROK_189_CONTEXTUAL_HINTS.some(key => has(record(ui.contextual_hints), key))) require('1.0.89');
  if (['classifier_model', 'classify_timeout_ms', 'prompt_type', 'reasoning_effort'].some(key => has(record(native.auto_mode), key))) require('1.0.90');
  if (has(features, 'wrap_image_relay') || has(record(native.models), 'headless_retry_deadline_secs')) require('1.0.92');
  if (includeOverrides && Array.isArray(native.version_overrides)) for (const layer of native.version_overrides) {
    const patch = record(layer);
    if (observed && !grokLayerApplies(patch, observed)) continue;
    const required = grokNativeMinimum(patch, observed, false);
    if (required) require(required);
  }
  return minimum;
}

// Preserve valid settings on older clients and skip inactive conditional layers.
const removedGrokFields = [
  ['features', 'zdr_access_enabled', '1.0.64', '1.0.63'],
  ['features', 'workspace_dashboard', '1.0.90', '1.0.89'],
  ['dashboard', 'grouping', '1.0.90', '1.0.89'],
] as const;

function grokLayerApplies(layer: Record<string, unknown>, observed: string): boolean {
  return !(typeof layer.minimum_version === 'string' && versionCompare(observed, layer.minimum_version) < 0)
    && !(typeof layer.maximum_version === 'string' && versionCompare(observed, layer.maximum_version) > 0);
}

/** `onFailure` on an `mcp_tool` hook needs Claude Code 2.1.328; older CLIs ignore it and fail open. */
function claudeMcpHookHasOnFailure(hooks: unknown): boolean {
  return Object.values(record(hooks)).some(groups => Array.isArray(groups) && groups.some(group => {
    const handlers = record(group).hooks;
    return Array.isArray(handlers) && handlers.some(handler => {
      const h = record(handler);
      return h.type === 'mcp_tool' && Object.hasOwn(h, 'onFailure');
    });
  }));
}

export function assertNativeConfigSupport(settings: unknown, host: Host | null, engine: Engine): void {
  if (!host) return;
  if (engine === 'kimi') {
    const raw = host.kimiClientVersion;
    const observed = typeof raw === 'string' ? raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] : undefined;
    const minimum = kimiNativeMinimum(record(settings).native_settings);
    if ((observed && versionCompare(observed, minimum) < 0) || (!observed && minimum !== '2.5.3'))
      throw new ValidationError(`Kimi native settings require CLI ${minimum} or newer (observed ${observed ?? 'unreported'}); run ckx update with a supported fleet version`, { param: 'settings.native_settings' });
    return;
  }
  if (engine === 'grok') {
    const native = record(record(settings).native_settings);
    const raw = host.grokClientVersion;
    const observed = typeof raw === 'string' ? raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] : undefined;
    if (observed) {
      const layers = [native, ...(Array.isArray(native.version_overrides)
        ? native.version_overrides.map(record).filter(layer => grokLayerApplies(layer, observed)) : [])];
      for (const [section, key, removed, previous] of removedGrokFields) {
        if (versionCompare(observed, removed) >= 0 && layers.some(layer => Object.hasOwn(record(layer[section]), key))) {
          throw new ValidationError(`grok native setting ${section}.${key} was removed in Grok Build ${removed}; observed ${observed}. Remove it, or keep it for older hosts in a version_overrides layer with maximum_version = "${previous}", then retry sync.`, { param: `settings.native_settings.${section}.${key}` });
        }
      }
    }
    const minimum = grokNativeMinimum(native, observed);
    if (minimum && (!observed || versionCompare(observed, minimum) < 0)) {
      throw new ValidationError(`grok native settings require CLI ${minimum} or newer; observed ${observed ?? 'unreported'}. Run cgx update (or cron run to report an already installed version), then retry sync.`, { param: 'settings.native_settings' });
    }
    return;
  }
  const value = record(settings);
  const root = Object.keys(record(value.native_settings)).length > 0;
  const profile = engine === 'codex' && Array.isArray(value.profiles)
    && value.profiles.some(p => Object.keys(record(record(p).native_settings)).length > 0);
  const scopes = [value, record(value.native_settings), ...(Array.isArray(value.profiles)
    ? value.profiles.flatMap(profile => [record(profile), record(record(profile).native_settings)]) : [])];
  const codex163 = engine === 'codex' && scopes.some(needsCodex163);
  const codex164 = engine === 'codex' && scopes.some(needsCodex164);
  const codex165 = engine === 'codex' && scopes.some(needsCodex165);
  const codex166 = engine === 'codex' && scopes.some(needsCodex166);
  const codex167 = engine === 'codex' && scopes.some(needsCodex167);
  const codex168 = engine === 'codex' && scopes.some(needsCodex168);
  const codex169 = engine === 'codex' && scopes.some(needsCodex169);
  const codex170 = engine === 'codex' && scopes.some(needsCodex170);
  const codex171 = engine === 'codex' && scopes.some(needsCodex171);
  if (!root && !profile && !codex168 && !codex169 && !codex170 && !codex171 && !codex163 && !codex164 && !codex165 && !codex166 && !codex167) return;
  const raw = engine === 'codex' ? host.clientVersion : host.claudeClientVersion;
  const observed = typeof raw === 'string' ? raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] : undefined;
  const claudeNestedNamespaces = engine === 'claude'
    && Object.hasOwn(record(record(value.native_settings).sandbox), 'allowNestedUserNamespaces');
  const claudeWriteBoundary = engine === 'claude'
    && Object.hasOwn(record(record(value.native_settings).permissions), 'blockWritesOutsideWorkingDirectories');
  const claudeDenyPrompts = engine === 'claude'
    && Object.hasOwn(record(record(value.native_settings).permissions), 'denyInsteadOfPrompting');
  const claudeMcpHookOnFailure = engine === 'claude' && claudeMcpHookHasOnFailure(record(value.native_settings).hooks);
  const minimum = codex171 ? '0.171.0' : codex170 ? '0.170.0' : codex169 ? '0.169.0' : codex168 ? '0.168.0' : codex167 ? '0.167.0' : codex166 ? '0.166.0' : codex165 ? '0.165.0' : codex164 ? '0.164.0' : codex163 ? '0.163.0' : claudeMcpHookOnFailure ? '2.1.328' : claudeDenyPrompts ? '2.1.319' : claudeWriteBoundary ? '2.1.314' : claudeNestedNamespaces ? '2.1.305' : NATIVE_CONFIG_MIN_VERSIONS[engine];
  if (!observed || versionCompare(observed, minimum) < 0) {
    throw new ValidationError(`${engine} native settings require CLI ${minimum} or newer; observed ${observed ?? 'unreported'}. Run ${engine === 'codex' ? 'cdx' : 'clx'} update (or cron run to report an already installed version), then retry sync.`, {
      param: root ? 'settings.native_settings' : profile ? 'settings.profiles' : 'settings',
    });
  }
}
