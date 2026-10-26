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
  'async_compaction', 'code_mode_host_grpc', 'code_mode_tool_description_first',
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
  if (has(record(native.keys), 'vim')) require('1.0.68');
  if (has(features, 'worktree_inherits_main_approvals')) require('1.0.67');
  if (has(record(record(native.ui).notifications), 'program_status')) require('1.0.63');
  for (const groups of Object.values(record(native.hooks))) {
    if (Array.isArray(groups)) for (const group of groups) {
      const handlers = record(group).hooks;
      if (Array.isArray(handlers) && handlers.some(handler => has(record(handler), 'args'))) require('1.0.63');
    }
  }
  if (['ask_answer_rows', 'cursor_marketplace', 'subagent_bundle', 'workflow_conversion', 'workspace_dashboard'].some(key => has(features, key))
    || has(record(native.diagnostics), 'error_reporting') || has(record(native.endpoints), 'web_base_url')
    || has(record(native.memory_v2), 'daily_token_cap')) require('1.0.70');
  for (const model of Object.values(record(native.model))) {
    const fields = record(model);
    if (has(fields, 'vision') || has(fields, 'compactions_remaining') || has(fields, 'send_compactions_remaining') || typeof fields.compaction_at_tokens === 'boolean') require('1.0.70');
  }
  for (const tool of ['image_gen', 'video_gen']) {
    const fields = record(record(native.toolset)[tool]);
    if (has(fields, 'base_url') || has(fields, 'env_key')) require('1.0.70');
  }
  if (includeOverrides && Array.isArray(native.version_overrides)) for (const layer of native.version_overrides) {
    const patch = record(layer);
    if (observed && ((typeof patch.minimum_version === 'string' && versionCompare(observed, patch.minimum_version) < 0)
      || (typeof patch.maximum_version === 'string' && versionCompare(observed, patch.maximum_version) > 0))) continue;
    const required = grokNativeMinimum(patch, observed, false);
    if (required) require(required);
  }
  return minimum;
}

export function assertNativeConfigSupport(settings: unknown, host: Host | null, engine: Engine): void {
  if (!host) return;
  if (engine === 'grok') {
    const native = record(record(settings).native_settings);
    const raw = host.grokClientVersion;
    const observed = typeof raw === 'string' ? raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] : undefined;
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
  if (!root && !profile && !codex163) return;
  const raw = engine === 'codex' ? host.clientVersion : host.claudeClientVersion;
  const observed = typeof raw === 'string' ? raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] : undefined;
  const minimum = codex163 ? '0.163.0' : NATIVE_CONFIG_MIN_VERSIONS[engine];
  if (!observed || versionCompare(observed, minimum) < 0) {
    throw new ValidationError(`${engine} native settings require CLI ${minimum} or newer; observed ${observed ?? 'unreported'}. Run ${engine === 'codex' ? 'cdx' : 'clx'} update (or cron run to report an already installed version), then retry sync.`, {
      param: root ? 'settings.native_settings' : profile ? 'settings.profiles' : 'settings',
    });
  }
}
