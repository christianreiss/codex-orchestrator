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
import { desc } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { clientConfigDocuments } from '../db/schema.js';
import { ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import {
  FORCE_UPGRADE_REASONING_EFFORT,
  type NormalizedSettings,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModel,
  normalizeSettings,
  normalizeStoredModel,
  isLegacyModelUpgrade,
  settingsHash,
} from './config-normalizer.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';
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
}

export function renderTomlForHost(opts: HostRenderOptions): RenderResult {
  const engine = opts.engine ?? ENGINE_CODEX;
  const settingsWithOverrides = applyHostModelOverrides(asRecord(opts.settings), opts.host);
  const normalized = normalizeSettings(settingsWithOverrides);
  const withManaged = injectManagedMcp(normalized, {
    host: opts.host,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    engine,
    managedMcpToken: opts.managedMcpToken,
  });
  let content = engine === ENGINE_CLAUDE
    ? renderClaudeSettings(withManaged)
    : renderToml(withManaged);
  if (engine !== ENGINE_CLAUDE) {
    content = injectTrustedProjectToml(content, normalizeHomePath(opts.home, opts.username));
  }
  return {
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    size_bytes: Buffer.byteLength(content, 'utf8'),
    settings: normalized,
  };
}

function applyHostModelOverrides(settings: Record<string, unknown>, host: Host | null): Record<string, unknown> {
  if (!host) return settings;
  const out = { ...settings };
  const rawModelOverride = host.modelOverride ?? null;
  const modelOverride = normalizeStoredModel(rawModelOverride);
  const forceUpgradedOverride = isLegacyModelUpgrade(rawModelOverride);
  const effectiveModel = modelOverride ?? normalizeStoredModel(out['model']);
  const effortOverrideRaw = normalizeReasoningEffort(host.reasoningEffortOverride ?? null);
  const effortOverride = forceUpgradedOverride && modelOverride !== null
    ? FORCE_UPGRADE_REASONING_EFFORT
    : normalizeReasoningEffortForModel(effortOverrideRaw, effectiveModel);

  if (modelOverride !== null) out['model'] = modelOverride;
  if (effortOverride !== null) out['model_reasoning_effort'] = effortOverride;

  const activeProfile = normalizeName(out['profile']);
  const profiles = Array.isArray(out['profiles']) ? out['profiles'] : null;
  if (activeProfile && profiles) {
    out['profiles'] = profiles.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const profile = { ...(entry as Record<string, unknown>) };
      if (normalizeName(profile['name']) !== activeProfile) return profile;
      const profileModel = modelOverride ?? normalizeStoredModel(profile['model']);
      const profileEffort = forceUpgradedOverride && modelOverride !== null
        ? FORCE_UPGRADE_REASONING_EFFORT
        : normalizeReasoningEffortForModel(effortOverrideRaw, profileModel);
      if (modelOverride !== null) profile['model'] = modelOverride;
      if (profileEffort !== null) profile['model_reasoning_effort'] = profileEffort;
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
  },
): NormalizedSettings {
  if (settings.orchestrator_mcp_enabled === false) return settings;
  const base = normalizeName(opts.baseUrl ?? null)?.replace(/\/+$/, '');
  const key = normalizeName(opts.apiKey ?? null);
  if (!base || !key) return settings;

  const secure = opts.host ? Boolean(opts.host.secure) : true;
  const bearerToken = secure ? key : normalizeName(opts.managedMcpToken ?? null);
  if (!bearerToken) return settings;

  const entry = {
    name: opts.engine === ENGINE_CLAUDE ? 'clx' : 'cdx',
    url: `${base}/mcp`,
    http_headers: { Authorization: `Bearer ${bearerToken}` },
    startup_timeout_sec: 30,
  };
  const managedNames = opts.engine === ENGINE_CLAUDE
    ? new Set(['codex-memory', 'codex-orchestrator', 'cdx', 'clx'])
    : new Set(['codex-memory', 'codex-orchestrator', 'cdx']);
  const filtered = settings.mcp_servers.filter((server) => {
    const name = normalizeName(server['name']);
    return !name || !managedNames.has(name.toLowerCase());
  });
  return { ...settings, mcp_servers: [entry, ...filtered] };
}

function renderClaudeSettings(settings: NormalizedSettings): string {
  const result: Record<string, unknown> = {};
  if (settings.model) result['model'] = settings.model;
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
  if (Object.keys(servers).length > 0) result['mcpServers'] = servers;
  return JSON.stringify(result, null, 2) + '\n';
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

  async adminFetch(): Promise<AdminFetchResult> {
    const rows = await this.db
      .select()
      .from(clientConfigDocuments)
      .orderBy(desc(clientConfigDocuments.id))
      .limit(1);
    const row = rows[0];
    if (!row) return { status: 'missing' };
    const body = row.body;
    const sha = row.sha256 ?? createHash('sha256').update(body).digest('hex');
    const settings = row.settings && typeof row.settings === 'object'
      ? normalizeSettings(row.settings)
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

  render(settingsInput: unknown): RenderResult {
    const normalized = normalizeSettings(settingsInput);
    const content = renderToml(normalized);
    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      size_bytes: Buffer.byteLength(content, 'utf8'),
      settings: normalized,
    };
  }

  async store(payload: { settings?: unknown; sha256?: unknown }, sourceHostId: number | null = null): Promise<StoreResult> {
    const rendered = this.render(payload.settings);

    const existingRows = await this.db
      .select()
      .from(clientConfigDocuments)
      .orderBy(desc(clientConfigDocuments.id))
      .limit(1);
    const existing = existingRows[0];

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
        createdAt: nowTs,
        updatedAt: nowTs,
      });
      savedSha = rendered.sha256;
      savedBody = rendered.content;
      savedUpdatedAt = nowTs;
      wsPublisher.publish('settings.changed', { kind: 'client_config', change });
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
