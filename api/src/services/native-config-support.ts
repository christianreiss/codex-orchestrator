import { needsCodex164 } from './codex-native-capabilities.js';
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

export function assertNativeConfigSupport(settings: unknown, host: Host | null, engine: Engine): void {
  if (!host || engine === 'grok') return;
  const value = record(settings);
  const root = Object.keys(record(value.native_settings)).length > 0;
  const profile = engine === 'codex' && Array.isArray(value.profiles)
    && value.profiles.some(p => Object.keys(record(record(p).native_settings)).length > 0);
  const scopes = [value, record(value.native_settings), ...(Array.isArray(value.profiles)
    ? value.profiles.flatMap(profile => [record(profile), record(record(profile).native_settings)]) : [])];
  const codex163 = engine === 'codex' && scopes.some(needsCodex163);
  const codex164 = engine === 'codex' && scopes.some(needsCodex164);
  if (!root && !profile && !codex163 && !codex164) return;
  const raw = engine === 'codex' ? host.clientVersion : host.claudeClientVersion;
  const observed = typeof raw === 'string' ? raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] : undefined;
  const claudeNestedNamespaces = engine === 'claude'
    && Object.hasOwn(record(record(value.native_settings).sandbox), 'allowNestedUserNamespaces');
  const minimum = codex164 ? '0.164.0' : codex163 ? '0.163.0' : claudeNestedNamespaces ? '2.1.305' : NATIVE_CONFIG_MIN_VERSIONS[engine];
  if (!observed || versionCompare(observed, minimum) < 0) {
    throw new ValidationError(`${engine} native settings require CLI ${minimum} or newer; observed ${observed ?? 'unreported'}. Run ${engine === 'codex' ? 'cdx' : 'clx'} update (or cron run to report an already installed version), then retry sync.`, {
      param: root ? 'settings.native_settings' : profile ? 'settings.profiles' : 'settings',
    });
  }
}
