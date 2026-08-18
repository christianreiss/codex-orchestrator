/**
 * Client config (codex/claude wrapper config.toml) admin service.
 *
 * - adminFetch() returns the latest stored config document.
 * - render(settings) normalizes + renders settings → TOML body, returning
 *   the sha and size_bytes.
 * - store(payload, sourceHostId) renders + upserts a new row into
 *   `client_config_documents`. The legacy PHP stores the latest doc and
 *   serves it back to hosts via /config/retrieve (a separate route).
 *
 * TOML structure intentionally mirrors src/Services/TomlRenderer.php:
 *
 *   <root scalars: model, model_provider, …>
 *   notify = […]
 *
 *   [features]
 *   …
 *   [notice]
 *   …
 *   [security]
 *   …
 *   [sandbox_workspace_write]
 *   …
 *   [shell_environment_policy]
 *   inherit = "…"
 *   set = { … }
 *   …
 *
 *   [[profiles]]
 *   name = "…"
 *   …
 *
 *   [[mcp_servers]]
 *   name = "…"
 *   …
 */
import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { clientConfigDocuments } from '../db/schema.js';
import { ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import {
  FORCE_UPGRADE_REASONING_EFFORT,
  CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS,
  type NormalizedSettings,
  defaultCodexReasoningEffortForModel,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModel,
  normalizeSettings,
  normalizeStoredModel,
  normalizeClaudeModel,
  normalizeClaudeEffortLevel,
  isLegacyModelUpgrade,
  modelEntry,
  settingsHash,
  DEFAULT_CLAUDE_PERMISSION_MODE,
} from './config-normalizer.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';
import { AGENT_MESSAGING_TOOLS } from './agent-messaging-tool-names.js';
import { securityLevelEnforcement, type SecurityLevels } from './agent-security-levels.js';
import {
  RESPONSE_VERBOSITY_OUTPUT_STYLE_SLUGS,
  type ResponseVerbosityLevel,
} from './agent-response-style.js';
import type { Host } from '../db/schema.js';

const SCALAR_KEYS: Array<keyof NormalizedSettings> = [
  'model',
  'model_provider',
  'local_provider',
  'profile',
  'personality',
  'approval_policy',
  'sandbox_mode',
  'web_search',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'model_supports_reasoning_summaries',
  'model_context_window',
  'model_max_output_tokens',
];

const BACKSPACE_CHAR = String.fromCharCode(0x08);

function tomlString(value: string): string {
  // Quote with double quotes, escape backslashes/quotes/control chars.
  // NOTE: use char-class \x08 for backspace; the JS regex `\b` matches
  // a word boundary (not a backspace) and would corrupt every word edge.
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .split(BACKSPACE_CHAR).join('\\b')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

function tomlValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => tomlValue(v)).filter((v): v is string => v !== null);
    return `[${parts.join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const parts: string[] = [];
    for (const [k, v] of entries) {
      const rendered = tomlValue(v);
      if (rendered !== null) parts.push(`${tomlBareKey(k)} = ${rendered}`);
    }
    return `{ ${parts.join(', ')} }`;
  }
  return null;
}

function tomlBareKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function isPresentRecord(rec: Record<string, unknown> | null | undefined): boolean {
  if (!rec) return false;
  return Object.values(rec).some((v) => v !== null && v !== undefined && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0));
}

function addKeyValue(lines: string[], key: string, value: unknown): void {
  const rendered = tomlValue(value);
  if (rendered === null) return;
  lines.push(`${tomlBareKey(key)} = ${rendered}`);
}

export function renderToml(normalized: NormalizedSettings): string {
  const lines: string[] = [];

  for (const key of SCALAR_KEYS) {
    addKeyValue(lines, key, normalized[key]);
  }

  if (normalized.notify && normalized.notify.length > 0) {
    addKeyValue(lines, 'notify', normalized.notify);
  }

  if (isPresentRecord(normalized.features)) {
    if (lines.length > 0) lines.push('');
    lines.push('[features]');
    const sortedKeys = Object.keys(normalized.features).sort();
    for (const k of sortedKeys) {
      addKeyValue(lines, k, normalized.features[k]);
    }
  }

  if (isPresentRecord(normalized.notice)) {
    if (lines.length > 0) lines.push('');
    lines.push('[notice]');
    const sortedKeys = Object.keys(normalized.notice).sort();
    for (const k of sortedKeys) {
      addKeyValue(lines, k, normalized.notice[k]);
    }
  }

  if (normalized.security.dangerously_bypass_approvals_and_sandbox !== null) {
    if (lines.length > 0) lines.push('');
    lines.push('[security]');
    addKeyValue(lines, 'dangerously_bypass_approvals_and_sandbox', normalized.security.dangerously_bypass_approvals_and_sandbox);
  }

  if (isPresentRecord(normalized.sandbox_workspace_write)) {
    if (lines.length > 0) lines.push('');
    lines.push('[sandbox_workspace_write]');
    const sw = normalized.sandbox_workspace_write;
    addKeyValue(lines, 'network_access', sw.network_access);
    addKeyValue(lines, 'exclude_tmpdir_env_var', sw.exclude_tmpdir_env_var);
    addKeyValue(lines, 'exclude_slash_tmp', sw.exclude_slash_tmp);
    addKeyValue(lines, 'writable_roots', sw.writable_roots);
  }

  if (isPresentRecord(normalized.shell_environment_policy)) {
    if (lines.length > 0) lines.push('');
    lines.push('[shell_environment_policy]');
    const sep = normalized.shell_environment_policy;
    addKeyValue(lines, 'inherit', sep.inherit);
    if (sep.set && typeof sep.set === 'object' && !Array.isArray(sep.set) && Object.keys(sep.set as object).length > 0) {
      addKeyValue(lines, 'set', sep.set);
    }
    addKeyValue(lines, 'ignore_default_excludes', sep.ignore_default_excludes);
    addKeyValue(lines, 'exclude', sep.exclude);
    addKeyValue(lines, 'include_only', sep.include_only);
  }

  for (const profile of sortEntriesByName(normalized.profiles)) {
    const name = normalizeName(profile['name']);
    if (!name) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`[profiles.${tomlBareKey(name)}]`);
    for (const key of SCALAR_KEYS) {
      if (key === 'profile' || key === 'local_provider') continue;
      addKeyValue(lines, key, profile[key]);
    }
    if (isPresentRecord(asRecord(profile['features']))) {
      lines.push('');
      lines.push(`[profiles.${tomlBareKey(name)}.features]`);
      for (const k of Object.keys(asRecord(profile['features'])).sort()) {
        addKeyValue(lines, k, asRecord(profile['features'])[k]);
      }
    }
    if (isPresentRecord(asRecord(profile['sandbox_workspace_write']))) {
      lines.push('');
      lines.push(`[profiles.${tomlBareKey(name)}.sandbox_workspace_write]`);
      addKeyValue(lines, 'network_access', asRecord(profile['sandbox_workspace_write'])['network_access']);
    }
  }

  for (const server of sortEntriesByName(normalized.mcp_servers)) {
    const name = normalizeName(server['name']);
    if (!name) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`[mcp_servers.${tomlBareKey(name)}]`);
    addKeyValue(lines, 'command', server['command']);
    addKeyValue(lines, 'args', server['args']);
    addKeyValue(lines, 'url', server['url']);
    addKeyValue(lines, 'bearer_token_env_var', server['bearer_token_env_var']);
    addKeyValue(lines, 'http_headers', server['http_headers']);
    addKeyValue(lines, 'env_http_headers', server['env_http_headers']);
    addKeyValue(lines, 'enabled', server['enabled']);
    addKeyValue(lines, 'startup_timeout_sec', server['startup_timeout_sec']);
    addKeyValue(lines, 'tool_timeout_sec', server['tool_timeout_sec']);
  }

  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function sortEntriesByName(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...entries].sort((a, b) => {
    const an = normalizeName(a['name']) ?? '';
    const bn = normalizeName(b['name']) ?? '';
    return an.localeCompare(bn);
  });
}

export interface HostRenderOptions {
  settings: unknown;
  host: Host | null;
  baseUrl: string | null | undefined;
  apiKey: string | null | undefined;
  engine?: Engine;
  managedMcpToken?: string | null;
  home?: string | null;
  username?: string | null;
  /** Effective global + secure-host gate for the local agent transport. */
  agentMessagingEnabled?: boolean;
  /** Resolved security posture for this host. Omitted leaves the template untouched. */
  securityLevels?: SecurityLevels | null;
  /** Fleet response-verbosity level (Claude only). 0/omitted leaves `outputStyle` untouched. */
  responseVerbosityLevel?: ResponseVerbosityLevel;
}

export function renderTomlForHost(opts: HostRenderOptions): RenderResult {
  const engine = opts.engine ?? ENGINE_CODEX;
  const settingsWithOverrides = applyPostureToSettings(
    applyHostModelOverrides(asRecord(opts.settings), opts.host, engine),
    opts.securityLevels,
    engine,
  );
  const normalized = normalizeSettings(settingsWithOverrides, { applyCodexDefaults: engine === ENGINE_CODEX });
  const withManaged = injectManagedMcp(normalized, {
    host: opts.host,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    engine,
    managedMcpToken: opts.managedMcpToken,
    agentMessagingEnabled: opts.agentMessagingEnabled,
  });
  const managedServerName = engine === ENGINE_CLAUDE ? 'clx' : 'cdx';
  const managedMcpInjected = withManaged.mcp_servers.some(
    (server) => normalizeName(server['name'])?.toLowerCase() === managedServerName,
  );
  let content = engine === ENGINE_CLAUDE
    ? renderClaudeSettings(withManaged)
    : renderToml(withManaged);
  if (engine !== ENGINE_CLAUDE) {
    if (managedMcpInjected) content = injectManagedCodexSkillPolicyToml(content);
    content = injectTrustedProjectToml(content, normalizeHomePath(opts.home, opts.username));
  }
  return {
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    size_bytes: Buffer.byteLength(content, 'utf8'),
    settings: normalized,
  };
}

/**
 * Fleet Skills are authoritative whenever the managed orchestrator MCP is
 * usable. Suppress Codex's built-in local creator in that exact case so its
 * higher-priority implicit trigger cannot bypass MCP discovery. Name matching
 * is supported by every Codex version admitted by the fleet floor and avoids
 * assuming the host's effective CODEX_HOME path.
 */
export function injectManagedCodexSkillPolicyToml(content: string): string {
  const stanza = '[[skills.config]]\nname = "skill-creator"\nenabled = false\n';
  if (content.includes(stanza)) return content;
  if (content.trim() === '') return stanza;
  return content.replace(/\s*$/, '\n\n') + stanza;
}

/**
 * Layer the host's resolved security posture over the fleet template, right
 * where `applyHostModelOverrides` layers its model columns: before
 * normalization, at bake time, per host.
 *
 * Deliberately an overlay rather than a write back into the stored document.
 * `docs/CONFIG_BUILDER.md` warns against a second editable owner of
 * `config.toml`, and with several profiles pointing at one fleet document there
 * is no sensible answer to "whose values get stored". Nothing is stored: the
 * operator's template stays theirs, and posture wins for the keys it claims —
 * the same ownership model as the Claude `owned_paths` merge.
 *
 * Note what is NOT emitted: `[security].dangerously_bypass_approvals_and_sandbox`.
 * The server renders that key today but no Go code parses it, and the wrapper
 * reads a *signed* `engine_options` variant the baker never emits. Deriving it
 * would be a level that claims to unlock something and silently does nothing.
 * At the top of the scale `approval_policy = never` plus
 * `sandbox_mode = danger-full-access` carry the grant through keys Codex reads.
 */
/** The mode a root host is served when its posture asks for a bypass it cannot boot with. */
export const ROOT_CLAMPED_CLAUDE_PERMISSION_MODE = 'auto';

export interface ClaudePermissionClamp {
  from: string;
  to: string;
  username: string;
}

/**
 * Refuse to serve a root host a permission mode Claude will not start in.
 *
 * Claude Code exits immediately when the resolved mode is `bypassPermissions` and the
 * process is running as root or under sudo:
 *
 *     --dangerously-skip-permissions cannot be used with root/sudo privileges
 *     for security reasons
 *
 * That check is deliberate and has no supported override -- no environment variable and
 * no flag. It is skipped only inside a sandbox Claude Code recognises, and the upstream
 * recommendation is to run as a non-root user instead. So a root host handed
 * `bypassPermissions` does not get a permissive agent; it gets an agent that cannot
 * launch at all, and the failure is invisible: a relay-booted peer dies before it can
 * report anything and its delivery goes terminally `ambiguous`, which reads exactly like
 * a peer that chose not to answer.
 *
 * `auto` is the substitute because it is what upstream recommends in place of a bypass
 * -- reads and working-directory edits are auto-approved and everything else is vetted
 * by a classifier rather than a prompt, so an unattended run still works. It is also
 * already this fleet's default mode, so it is not a new posture for anyone.
 *
 * This is a *delivery* constraint, not a posture change. `securityLevelEnforcement`
 * still reports that the posture asks for `bypassPermissions`, and a non-root host still
 * receives it. Folding this into the posture mapping instead would break its
 * monotonicity guarantee and would lie about what the operator selected.
 *
 * Keyed on the username the wrapper sends with each sync, which is exactly the user
 * whose `~/.claude/settings.json` this render becomes. An older wrapper sends no
 * username; that is treated as non-root and left alone, so an unidentified host is never
 * silently weakened. Those hosts stay broken as they are today, and `clx doctor` names
 * the reason host-side, where the uid is known for certain rather than asserted.
 */
export function clampClaudePermissionModeForUser(
  settings: Record<string, unknown>,
  username: string | null | undefined,
): { settings: Record<string, unknown>; clamped: ClaudePermissionClamp | null } {
  const user = normalizeName(username ?? null);
  if (user !== 'root') return { settings, clamped: null };
  const mode = normalizeName(settings['permissionMode']);
  if (mode !== 'bypassPermissions') return { settings, clamped: null };
  return {
    settings: { ...settings, permissionMode: ROOT_CLAMPED_CLAUDE_PERMISSION_MODE },
    clamped: { from: mode, to: ROOT_CLAMPED_CLAUDE_PERMISSION_MODE, username: user },
  };
}

export function applyPostureToSettings(
  settings: Record<string, unknown>,
  levels: SecurityLevels | null | undefined,
  engine: Engine = ENGINE_CODEX,
): Record<string, unknown> {
  if (!levels) return settings;
  const derived = securityLevelEnforcement(levels);
  const out = { ...settings };

  if (engine === ENGINE_CLAUDE) {
    out['permissionMode'] = derived.claude.permission_mode.value;
    return out;
  }

  out['approval_policy'] = derived.codex.approval_policy.value;
  out['sandbox_mode'] = derived.codex.sandbox_mode.value;
  out['web_search'] = derived.codex.web_search.value;

  // Merge rather than replace: the operator's writable_roots and exclusions are
  // theirs, and posture only claims the network switch.
  const workspace = asRecord(out['sandbox_workspace_write']);
  out['sandbox_workspace_write'] = {
    ...workspace,
    network_access: derived.codex.network_access.value,
  };

  const features = asRecord(out['features']);
  out['features'] = {
    ...features,
    guardian_approval: derived.codex.guardian_approval.value,
  };

  return out;
}

function applyHostModelOverrides(
  settings: Record<string, unknown>,
  host: Host | null,
  engine: Engine = ENGINE_CODEX,
): Record<string, unknown> {
  if (!host) return settings;
  // Claude reads model/effort overrides from the claude_* columns. Unlike
  // Codex, Claude has no profile layer, so the overrides apply at the root.
  if (engine === ENGINE_CLAUDE) {
    const out = { ...settings };
    const claudeModel = normalizeClaudeModel(host.claudeModelOverride ?? null);
    const effectiveModel = claudeModel ?? normalizeClaudeModel(out['model']);
    const explicitEffort = normalizeClaudeEffortLevel(
      host.claudeReasoningEffortOverride ?? null,
      effectiveModel,
    );
    if (claudeModel !== null) {
      out['model'] = claudeModel;
      const effortLevel = explicitEffort
        ?? modelEntry(CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS, claudeModel)
        ?? null;
      if (effortLevel === null) delete out['effortLevel'];
      else out['effortLevel'] = effortLevel;
    } else if (explicitEffort !== null) {
      out['effortLevel'] = explicitEffort;
    }
    return out;
  }
  const out = { ...settings };
  const rawModelOverride = host.modelOverride ?? null;
  const modelOverride = normalizeStoredModel(rawModelOverride);
  const forceUpgradedOverride = isLegacyModelUpgrade(rawModelOverride);
  const effectiveModel = modelOverride ?? normalizeStoredModel(out['model']);
  const effortOverrideRaw = normalizeReasoningEffort(host.reasoningEffortOverride ?? null);
  const effortOverride = modelOverride !== null
    ? forceUpgradedOverride
      ? FORCE_UPGRADE_REASONING_EFFORT
      : normalizeReasoningEffortForModel(effortOverrideRaw, modelOverride)
        ?? defaultCodexReasoningEffortForModel(modelOverride)
    : normalizeReasoningEffortForModel(effortOverrideRaw, effectiveModel);

  if (modelOverride !== null) out['model'] = modelOverride;
  if (effortOverride !== null) out['model_reasoning_effort'] = effortOverride;
  else if (modelOverride !== null) delete out['model_reasoning_effort'];

  const activeProfile = normalizeName(out['profile']);
  const profiles = Array.isArray(out['profiles']) ? out['profiles'] : null;
  if (activeProfile && profiles) {
    out['profiles'] = profiles.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const profile = { ...(entry as Record<string, unknown>) };
      if (normalizeName(profile['name']) !== activeProfile) return profile;
      const profileModel = modelOverride ?? normalizeStoredModel(profile['model']) ?? effectiveModel;
      const profileEffort = modelOverride !== null
        ? effortOverride
        : normalizeReasoningEffortForModel(effortOverrideRaw, profileModel);
      if (modelOverride !== null) profile['model'] = modelOverride;
      if (profileEffort !== null) profile['model_reasoning_effort'] = profileEffort;
      else if (modelOverride !== null) delete profile['model_reasoning_effort'];
      return profile;
    });
  }
  return out;
}

function injectManagedMcp(
  settings: NormalizedSettings,
  opts: {
    host: Host | null;
    baseUrl: string | null | undefined;
    apiKey: string | null | undefined;
    engine: Engine;
    managedMcpToken?: string | null;
    agentMessagingEnabled?: boolean;
  },
): NormalizedSettings {
  const availability = managedMcpAvailability({
    settings,
    host: opts.host,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
  });
  const managedNames = new Set<string>();
  const managedEntries: Array<Record<string, unknown>> = [];
  if (availability.enabled) {
    const base = normalizeName(opts.baseUrl ?? null)!.replace(/\/+$/, '');
    const key = normalizeName(opts.apiKey ?? null)!;
    const secure = opts.host ? Boolean(opts.host.secure) : true;
    const bearerToken = secure ? key : normalizeName(opts.managedMcpToken ?? null);
    if (bearerToken) {
      const name = opts.engine === ENGINE_CLAUDE ? 'clx' : 'cdx';
      managedEntries.push({
        name,
        url: `${base}/mcp`,
        http_headers: { Authorization: `Bearer ${bearerToken}`, 'X-Engine': opts.engine },
        startup_timeout_sec: 30,
      });
      for (const reserved of opts.engine === ENGINE_CLAUDE
        ? ['codex-memory', 'codex-orchestrator', 'cdx', 'clx']
        : ['codex-memory', 'codex-orchestrator', 'cdx']) {
        managedNames.add(reserved);
      }
      if (opts.engine === ENGINE_CODEX && opts.host?.browserosMcpEnabled === 1) {
        managedNames.add('browseros');
        managedEntries.push({
          name: 'browseros',
          url: 'http://127.0.0.1:9000/mcp',
          startup_timeout_sec: 30,
        });
      }
    }
  }
  // Provisioning, not authorization. The MCP server is injected whenever the
  // fleet switch is on so the agent_* tools are stably present; an insecure
  // host's calls are authorized per operation against its allowed window,
  // which would otherwise add and remove tools every few minutes.
  const agentMessagingEnabled = opts.agentMessagingEnabled === true;
  if (agentMessagingEnabled) {
    managedNames.add('cxx-agent');
    managedEntries.push({
      name: 'cxx-agent',
      command: 'cxx',
      args: ['agent', 'mcp'],
      startup_timeout_sec: 30,
      tool_timeout_sec: 35,
    });
  }
  if (managedEntries.length === 0) return settings;
  const filtered = settings.mcp_servers.filter((server) => {
    const name = normalizeName(server['name']);
    return !name || !managedNames.has(name.toLowerCase());
  });
  return { ...settings, mcp_servers: [...managedEntries, ...filtered] };
}

export interface ManagedMcpAvailability {
  enabled: boolean;
  reason: 'ok' | 'mcp_disabled' | 'service_unavailable';
}

/**
 * Whether the fleet-managed orchestrator MCP entry is enabled and can be
 * provisioned for a host on its next config sync.
 *
 * Keep this predicate shared with the AGENTS/CLAUDE feature supplement: a
 * document must never advertise MCP-backed capabilities when the matching
 * client settings cannot contain the managed MCP server. An insecure host
 * intentionally qualifies without passing its ephemeral bearer here: the
 * config-sync caller mints that bearer immediately before rendering, while
 * feature activation itself depends on the stable URL/key/toggle inputs.
 */
export function managedMcpAvailability(opts: {
  settings: NormalizedSettings;
  host: Host | null;
  baseUrl: string | null | undefined;
  apiKey: string | null | undefined;
}): ManagedMcpAvailability {
  if (opts.settings.orchestrator_mcp_enabled === false) {
    return { enabled: false, reason: 'mcp_disabled' };
  }
  const base = normalizeName(opts.baseUrl ?? null);
  const key = normalizeName(opts.apiKey ?? null);
  if (!base || !key) {
    return { enabled: false, reason: 'service_unavailable' };
  }
  return { enabled: true, reason: 'ok' };
}

function buildClaudeMcpServers(settings: NormalizedSettings): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const entry of settings.mcp_servers) {
    const name = normalizeName(entry['name']);
    if (!name || entry['enabled'] === false) continue;
    const url = normalizeName(entry['url']);
    if (url) {
      const server: Record<string, unknown> = { type: 'http', url };
      const headers = asRecord(entry['http_headers']);
      if (Object.keys(headers).length > 0) server['headers'] = headers;
      servers[name] = server;
      continue;
    }
    const command = normalizeName(entry['command']);
    if (!command) continue;
    const server: Record<string, unknown> = { command };
    if (Array.isArray(entry['args'])) server['args'] = entry['args'];
    if (isPresentRecord(asRecord(entry['env']))) server['env'] = entry['env'];
    servers[name] = server;
  }
  return servers;
}

// Legacy full-file render (wholesale overwrite path for old clx wrappers).
function renderClaudeSettings(settings: NormalizedSettings): string {
  const result: Record<string, unknown> = {};
  if (settings.model) result['model'] = settings.model;
  if (settings.effortLevel) result['effortLevel'] = settings.effortLevel;
  const servers = buildClaudeMcpServers(settings);
  if (Object.keys(servers).length > 0) result['mcpServers'] = servers;
  if (settings.env) result['env'] = settings.env;
  if (settings.statusLine) result['statusLine'] = settings.statusLine;
  if (settings.hooks) result['hooks'] = settings.hooks;
  const perms: Record<string, unknown> = {};
  if (settings.permissions) {
    for (const bucket of ['allow', 'ask', 'deny'] as const) {
      const arr = settings.permissions[bucket];
      if (arr && arr.length > 0) perms[bucket] = arr;
    }
  }
  // Claude Code reads the default permission mode from `permissions.defaultMode`
  // (a top-level `permissionMode` key is ignored). Always emit it so the fleet
  // default (`auto`) lands even when no rules are configured.
  perms['defaultMode'] = settings.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE;
  result['permissions'] = perms;
  return JSON.stringify(result, null, 2) + '\n';
}

/**
 * Partial Claude settings.json for the deep-merge wrapper path: emits ONLY the
 * fleet-managed keys plus the leaf-granular `owned_paths` list the wrapper uses
 * to add/update/remove exactly those keys without clobbering user-owned keys.
 * `owned_paths` deliberately includes the legacy `model` + each managed
 * `mcpServers.<name>` so the first merge reconciles (not duplicates) them.
 */
/**
 * The memory tools an agent needs to CURATE rather than merely read. Listing,
 * searching, and reading are deliberately absent: they were already allowed, and
 * that asymmetry is the problem being fixed, not a pattern to extend.
 */
const CURATION_TOOLS = [
  'shared_memory_write',
  'shared_memory_append',
  'shared_memory_delete',
  'project_memory_upsert',
  'project_memory_delete',
] as const;

/**
 * The ringer: the two hooks that let an attached session find out it is being
 * called.
 *
 * An interactive agent has no interrupt -- it exists only during a turn -- so a
 * message addressed to an attached session sits queued until it expires and
 * neither side ever learns a call was placed. The relay cannot cover this gap
 * either: it deliberately skips any address whose wrapper is attached. The two
 * turn boundaries these hooks sit on are therefore the only moments at which a
 * notification can land at all.
 *
 * `cxx` resolves on PATH exactly as the managed `cxx-agent` MCP entry already
 * assumes. Two details are load-bearing:
 *
 * - `|| true` is not decoration. A `Stop` hook that exits non-zero *blocks the
 *   turn* with its stderr as feedback, so a wrapper too old to know `agent poll`
 *   would wedge every turn on an unknown-command error. Forcing exit 0 makes the
 *   hook a no-op on any wrapper that cannot serve it, which is what lets this
 *   ship without version-gating.
 * - `cxx agent poll` prints nothing when it has nothing to report or cannot
 *   reach the orchestrator, and empty stdout with exit 0 means "no decision".
 *   An unreachable server therefore costs one process spawn per turn boundary
 *   and changes nothing else.
 *
 * Codex gets no equivalent because it has no hook surface; a Codex peer is
 * reachable only while it is actively listening.
 */
function managedRingerHooks(): Record<string, unknown[]> {
  const ring = (event: string) => [
    { hooks: [{ type: 'command', command: `cxx agent poll --hook ${event} 2>/dev/null || true`, timeout: 10 }] },
  ];
  return { Stop: ring('Stop'), UserPromptSubmit: ring('UserPromptSubmit') };
}

export function renderClaudeSettingsPartial(
  settings: NormalizedSettings,
): { partial: Record<string, unknown>; owned_paths: string[] } {
  const partial: Record<string, unknown> = {};
  const owned: string[] = [];
  if (settings.model) {
    partial['model'] = settings.model;
    owned.push('model');
  }
  if (settings.effortLevel) {
    partial['effortLevel'] = settings.effortLevel;
    owned.push('effortLevel');
  }
  // NOTE: Claude Code does NOT read mcpServers from settings.json — the wrapper
  // (clx >= 0.6.21) splits the mcpServers.* owned paths out of this partial and
  // merges them into the top level of ~/.claude.json, where user-scope MCP
  // servers actually live. They stay in the partial so the transport contract
  // is unchanged for older wrappers.
  const servers = buildClaudeMcpServers(settings);
  if (Object.keys(servers).length > 0) {
    partial['mcpServers'] = servers;
    for (const name of Object.keys(servers)) owned.push(`mcpServers.${name}`);
  }
  if (settings.env) {
    partial['env'] = settings.env;
    for (const k of Object.keys(settings.env)) owned.push(`env.${k}`);
  }
  if (settings.statusLine) {
    partial['statusLine'] = settings.statusLine;
    owned.push('statusLine');
  }
  if (settings.hooks) {
    partial['hooks'] = settings.hooks;
    for (const event of Object.keys(settings.hooks)) owned.push(`hooks.${event}`);
  }
  const perms: Record<string, unknown> = {};
  if (settings.permissions) {
    for (const bucket of ['allow', 'ask', 'deny'] as const) {
      const arr = settings.permissions[bucket];
      if (arr && arr.length > 0) {
        perms[bucket] = arr;
        owned.push(`permissions.${bucket}`);
      }
    }
  }
  // Curating memory must not be the option that interrupts the user.
  //
  // Reads were already frictionless while every write, append, and delete raised
  // a prompt, so the permission config pushed agents toward exactly the
  // read-only behaviour the corpus shows: 113 reads to 3 writes, and zero
  // deletes in 9354 sessions. Now that the managed AGENTS.md block tells agents
  // to correct stale records as part of the task they are already doing, leaving
  // that asymmetry in place would make the instruction and the incentive point
  // in opposite directions.
  //
  // Derived from the configured server names rather than hardcoded, because the
  // tool identifier Claude Code matches on is `mcp__<server>__<tool>` and the
  // server name comes from client config. The wrapper unions these with the
  // user's own rules and removes them again if this ownership ever drops, so
  // this stays reversible.
  const curationAllow = Object.keys(servers).flatMap((server) =>
    CURATION_TOOLS.map((tool) => `mcp__${server}__${tool}`),
  );
  const agentMessagingAllow = servers['cxx-agent']
    ? AGENT_MESSAGING_TOOLS.map((tool) => `mcp__cxx-agent__${tool}`)
    : [];
  // Same signal as the permission allowlist above: if the bus is provisioned,
  // this session is addressable, and an addressable session needs a ringer.
  // Operator-configured hooks for the same events are preserved and the ring is
  // appended, mirroring how `permissions.allow` unions rather than replaces.
  if (servers['cxx-agent']) {
    const configured = asRecord(partial['hooks']);
    const merged: Record<string, unknown> = { ...configured };
    for (const [event, groups] of Object.entries(managedRingerHooks())) {
      const prior = Array.isArray(configured[event]) ? (configured[event] as unknown[]) : [];
      merged[event] = [...prior, ...groups];
      if (!owned.includes(`hooks.${event}`)) owned.push(`hooks.${event}`);
    }
    partial['hooks'] = merged;
  }
  if (curationAllow.length > 0 || agentMessagingAllow.length > 0) {
    const existing = Array.isArray(perms['allow']) ? (perms['allow'] as string[]) : [];
    perms['allow'] = [...new Set([...existing, ...curationAllow, ...agentMessagingAllow])];
    if (!owned.includes('permissions.allow')) owned.push('permissions.allow');
  }
  // `permissions.defaultMode` is a plain leaf path: it rides the generic dotted
  // merge in the wrapper (NOT the allow/ask/deny union special-case), so it is
  // written verbatim and removed via the stale-path pass when ownership drops.
  // Claude Code ignores a top-level `permissionMode`; this is the honored form.
  perms['defaultMode'] = settings.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE;
  owned.push('permissions.defaultMode');
  partial['permissions'] = perms;
  if (settings.advisorModel) {
    partial['advisorModel'] = settings.advisorModel;
    owned.push('advisorModel');
  }
  return { partial, owned_paths: owned };
}

/** Host-aware partial render (applies per-host claude model + managed clx MCP). */
export function renderClaudeSettingsPartialForHost(
  opts: HostRenderOptions,
): { partial: Record<string, unknown>; owned_paths: string[]; sha256: string; clamped: ClaudePermissionClamp | null } {
  const posture = applyPostureToSettings(
    applyHostModelOverrides(asRecord(opts.settings), opts.host, ENGINE_CLAUDE),
    opts.securityLevels,
    ENGINE_CLAUDE,
  );
  // Last, so it clamps whatever actually won -- posture, host override or template.
  const { settings: settingsWithOverrides, clamped } = clampClaudePermissionModeForUser(
    posture,
    opts.username,
  );
  const normalized = normalizeSettings(settingsWithOverrides, { applyCodexDefaults: false });
  const withManaged = injectManagedMcp(normalized, {
    host: opts.host,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    engine: ENGINE_CLAUDE,
    managedMcpToken: opts.managedMcpToken,
    agentMessagingEnabled: opts.agentMessagingEnabled,
  });
  const { partial, owned_paths } = renderClaudeSettingsPartial(withManaged);
  // Component B of the response-verbosity dial: reinforce the CLAUDE.md policy
  // text with Claude Code's own output-style mechanism. Level 0 (or unset)
  // omits the key entirely so a host/user's manually chosen style is left
  // alone, same as every other allowlisted key when its source input is empty.
  const outputStyleSlug = opts.responseVerbosityLevel
    ? RESPONSE_VERBOSITY_OUTPUT_STYLE_SLUGS[opts.responseVerbosityLevel]
    : undefined;
  if (outputStyleSlug) {
    partial['outputStyle'] = outputStyleSlug;
    owned_paths.push('outputStyle');
  }
  const json = JSON.stringify(partial, null, 2) + '\n';
  return { partial, owned_paths, sha256: createHash('sha256').update(json).digest('hex'), clamped };
}

export function normalizeHomePath(home: string | null | undefined, username: string | null | undefined): string | null {
  const rawHome = normalizeName(home ?? null);
  if (rawHome) return rawHome;
  const user = normalizeName(username ?? null);
  if (!user) return null;
  const base = user.includes('\\') ? user.split('\\').pop() : user;
  return base ? `/home/${base}` : null;
}

export function injectTrustedProjectToml(content: string, homePath: string | null): string {
  if (!homePath) return content;
  const header = `[projects.${tomlString(homePath)}]`;
  if (content.includes(header)) return content;
  const stanza = `${header}\ntrust_level = "trusted"\n`;
  if (content.trim() === '') return stanza;
  return content.replace(/\s*$/, '\n\n') + stanza;
}

export interface RenderResult {
  content: string;
  sha256: string;
  size_bytes: number;
  settings: NormalizedSettings;
}

export interface AdminFetchResult {
  status: 'missing' | 'ok';
  sha256?: string;
  updated_at?: string | null;
  size_bytes?: number;
  content?: string;
  settings?: NormalizedSettings | null;
}

export interface StoreResult extends AdminFetchResult {
  status: 'ok';
  sha256: string;
  updated_at: string | null;
  size_bytes: number;
  content: string;
  settings: NormalizedSettings;
  change: 'created' | 'updated' | 'unchanged';
}

export class ClientConfigService {
  constructor(private readonly db: Database) {}

  async adminFetch(engine: Engine = ENGINE_CODEX): Promise<AdminFetchResult> {
    const rows = await this.db
      .select()
      .from(clientConfigDocuments)
      .where(eq(clientConfigDocuments.engine, engine))
      .orderBy(desc(clientConfigDocuments.id))
      .limit(1);
    const row = rows.find((r) => r.engine === engine) ?? rows[0];
    if (!row) return { status: 'missing' };
    const body = row.body;
    const sha = row.sha256 ?? createHash('sha256').update(body).digest('hex');
    const settings = row.settings && typeof row.settings === 'object'
      ? normalizeSettings(row.settings, { applyCodexDefaults: engine === ENGINE_CODEX })
      : null;
    return {
      status: 'ok',
      sha256: sha,
      updated_at: row.updatedAt,
      size_bytes: Buffer.byteLength(body, 'utf8'),
      content: body,
      settings,
    };
  }

  render(settingsInput: unknown, engine: Engine = ENGINE_CODEX): RenderResult {
    const normalized = normalizeSettings(settingsInput, { applyCodexDefaults: engine === ENGINE_CODEX });
    const content = engine === ENGINE_CLAUDE ? renderClaudeSettings(normalized) : renderToml(normalized);
    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      size_bytes: Buffer.byteLength(content, 'utf8'),
      settings: normalized,
    };
  }

  async store(
    payload: { settings?: unknown; sha256?: unknown },
    sourceHostId: number | null = null,
    engine: Engine = ENGINE_CODEX,
  ): Promise<StoreResult> {
    const rendered = this.render(payload.settings, engine);

    const existingRows = await this.db
      .select()
      .from(clientConfigDocuments)
      .where(eq(clientConfigDocuments.engine, engine))
      .orderBy(desc(clientConfigDocuments.id))
      .limit(1);
    const existing = existingRows.find((r) => r.engine === engine) ?? existingRows[0];

    if (payload.sha256 !== undefined && payload.sha256 !== null && payload.sha256 !== '') {
      if (typeof payload.sha256 !== 'string') {
        throw new ValidationError('sha256 must be a string', { param: 'sha256' });
      }
      const provided = payload.sha256.trim().toLowerCase();
      if (provided === '' || !/^[a-f0-9]{64}$/.test(provided)) {
        throw new ValidationError('sha256 must be 64 hex characters when provided', { param: 'sha256' });
      }
      if (existing && existing.sha256.toLowerCase() !== provided) {
        throw new ValidationError(
          'sha256 does not match current saved config.toml (reload before saving)',
          { param: 'sha256' },
        );
      }
    }

    if (rendered.content === '') {
      throw new ValidationError('config cannot be empty', { param: 'settings' });
    }

    let change: 'created' | 'updated' | 'unchanged' = 'created';
    if (existing) {
      const contentUnchanged = existing.sha256 === rendered.sha256;
      const settingsUnchanged = settingsHash(existing.settings ?? {}) === settingsHash(rendered.settings);
      change = contentUnchanged && settingsUnchanged ? 'unchanged' : 'updated';
    }

    let savedSha: string;
    let savedBody: string;
    let savedUpdatedAt: string;

    if (change === 'unchanged' && existing) {
      savedSha = existing.sha256;
      savedBody = existing.body;
      savedUpdatedAt = existing.updatedAt;
    } else {
      const nowTs = nowIso();
      await this.db.insert(clientConfigDocuments).values({
        sha256: rendered.sha256,
        body: rendered.content,
        settings: rendered.settings as unknown as Record<string, unknown>,
        sourceHostId,
        engine,
        createdAt: nowTs,
        updatedAt: nowTs,
      });
      savedSha = rendered.sha256;
      savedBody = rendered.content;
      savedUpdatedAt = nowTs;
      wsPublisher.publish('settings.changed', { kind: 'client_config', change, engine });
    }

    return {
      status: 'ok',
      sha256: savedSha,
      updated_at: savedUpdatedAt,
      size_bytes: Buffer.byteLength(savedBody, 'utf8'),
      content: savedBody,
      settings: rendered.settings,
      change,
    };
  }
}
