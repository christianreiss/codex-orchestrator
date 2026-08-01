/**
 * Host-facing agents + client config retrieval.
 */
import { eq, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import { agentsDocuments, agentsDocumentState, clientConfigDocuments, logs } from '../db/schema.js';
import type { Host } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';
import { ENGINE_CODEX, ENGINE_CLAUDE, type Engine } from '../util/engine.js';
import { decryptOrNull } from '../security/secret-box.js';
import type { Keyring } from '../security/keyring.js';
import { McpSessionService } from './mcp-session.js';
import { managedMcpAvailability, renderTomlForHost, renderClaudeSettingsPartialForHost } from './client-config.js';
import { normalizeSettings } from './config-normalizer.js';
import { HostSkillsService } from './host-skills.js';
import { ProjectsService } from './projects.js';
import { SecretsService } from './secrets.js';
import { SettingsService } from './settings.js';
import { AGENT_MESSAGING_ENABLED_KEY } from './agent-messaging.js';
import {
  renderManagedAgentFeatures,
  type ManagedAgentFeatureContext,
  type ManagedFeatureState,
} from './managed-agents-features.js';

const STATE_ID_CODEX = 1;
const STATE_ID_CLAUDE = 2;
const MODE_LOCKED = 'locked';

export class HostAgentsService {
  private readonly publicBaseUrl: string | null;
  private readonly keyring: Keyring | null;
  private readonly mcpSessions: McpSessionService;
  private readonly skills: HostSkillsService;
  private readonly projects: ProjectsService;
  private readonly secrets: SecretsService;
  private readonly settings: SettingsService;

  constructor(
    private readonly db: Database,
    deps: { publicBaseUrl?: string | null; keyring?: Keyring | null } = {},
  ) {
    this.publicBaseUrl = deps.publicBaseUrl?.replace(/\/+$/, '') ?? null;
    this.keyring = deps.keyring ?? null;
    this.mcpSessions = new McpSessionService(db);
    this.skills = new HostSkillsService(db);
    this.projects = new ProjectsService(db);
    this.settings = new SettingsService(db);
    // No keyring: this instance only ever answers "is the module on, and how
    // many secrets can this engine see?". Rendering guidance must not be able
    // to touch ciphertext, and omitting the keyring makes that structural.
    this.secrets = new SecretsService({ db });
  }

  /**
   * Render the exact current document a host would receive, without recording
   * a host sync. Admin preview uses this instead of calling `retrieve`, so an
   * operator opening the preview cannot manufacture telemetry.
   */
  async renderCurrent(host: Host, engine: Engine = ENGINE_CODEX): Promise<Record<string, unknown>> {
    return await this.renderForHost(host, engine, false);
  }

  async retrieve(providedSha: string | null, host: Host, engine: Engine = ENGINE_CODEX): Promise<Record<string, unknown>> {
    const rendered = await this.renderForHost(host, engine, true);
    if (rendered['status'] === 'missing') {
      await this.recordLog(host.id, 'agents.retrieve', { status: 'missing' });
      return rendered;
    }

    const { content, ...metadata } = rendered;
    const served = String(content ?? '');
    const servedSha = String(metadata['sha256'] ?? '');
    // Compare against the SERVED hash: comparing the canonical one would report
    // `unchanged` to a host whose on-disk copy predates the managed block.
    const status = providedSha && safeHashEquals(servedSha, providedSha) ? 'unchanged' : 'updated';
    const out: Record<string, unknown> = { ...metadata, status };
    if (status !== 'unchanged') out['content'] = served;
    await this.recordLog(host.id, 'agents.retrieve', { status, engine });
    return out;
  }

  private async renderForHost(
    host: Host,
    engine: Engine,
    recordMissingOverride: boolean,
  ): Promise<Record<string, unknown>> {
    const row = await this.resolveServedDocument(host, engine, recordMissingOverride);
    if (!row) {
      return { status: 'missing' };
    }

    const body = row.body ?? '';
    const baseSha = row.sha256 || createHash('sha256').update(body).digest('hex');
    const featureContext = await this.resolveManagedFeatureContext(host, engine);
    const rendered = renderManagedAgentFeatures(body, featureContext);
    const served = rendered.body;
    const servedSha = createHash('sha256').update(served).digest('hex');
    return {
      status: 'ok',
      version_id: Number(row.id),
      sha256: servedSha,
      base_sha256: baseSha,
      managed_sha256: rendered.managed_sha256,
      sections: rendered.sections,
      updated_at: row.updatedAt,
      size_bytes: Buffer.byteLength(served, 'utf8'),
      content: served,
    };
  }

  async retrieveConfig(
    providedSha: string | null,
    host: Host,
    engine: Engine = ENGINE_CODEX,
    opts: { home?: string | null; username?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select()
      .from(clientConfigDocuments)
      .where(eq(clientConfigDocuments.engine, engine))
      .orderBy(desc(clientConfigDocuments.id))
      .limit(1);
    let row = rows[0];
    if (!row && engine !== ENGINE_CODEX) {
      const fallback = await this.db
        .select()
        .from(clientConfigDocuments)
        .where(eq(clientConfigDocuments.engine, ENGINE_CODEX))
        .orderBy(desc(clientConfigDocuments.id))
        .limit(1);
      row = fallback[0];
    }
    if (!row) {
      await this.recordLog(host.id, 'config.retrieve', { status: 'missing' });
      return { status: 'missing' };
    }
    const body = row.body ?? '';
    const baseSha = row.sha256 || createHash('sha256').update(body).digest('hex');
    let rendered = {
      content: body,
      sha256: baseSha,
      size_bytes: Buffer.byteLength(body, 'utf8'),
    };
    const settings = row.settings && typeof row.settings === 'object' ? row.settings : null;
    const apiKey = this.resolveApiKey(host);
    const managedMcpToken = settings && this.publicBaseUrl && apiKey && !host.secure
      ? (await this.mcpSessions.issue(host.id)).token
      : null;
    const agentMessagingEnabled = host.secure === 1
      && host.agentMessagingEnabled === 1
      && await this.settings.getFlag(AGENT_MESSAGING_ENABLED_KEY, false);
    if (settings && this.publicBaseUrl && apiKey) {
      rendered = renderTomlForHost({
        settings,
        host,
        baseUrl: this.publicBaseUrl,
        apiKey,
        engine,
        managedMcpToken,
        home: opts.home ?? null,
        username: opts.username ?? null,
        agentMessagingEnabled,
      });
    }
    const status = providedSha && safeHashEquals(rendered.sha256, providedSha) ? 'unchanged' : 'updated';
    const out: Record<string, unknown> = {
      status,
      version_id: Number(row.id),
      sha256: rendered.sha256,
      base_sha256: baseSha,
      updated_at: row.updatedAt,
      size_bytes: rendered.size_bytes,
    };
    if (status !== 'unchanged') out['content'] = rendered.content;
    await this.recordLog(host.id, 'config.retrieve', { status, base_sha256: baseSha, baked_sha256: rendered.sha256 });
    return out;
  }

  /**
   * Claude settings as a deep-merge PARTIAL: only fleet-managed keys plus the
   * `owned_paths` list the wrapper uses to add/update/remove them without
   * clobbering user-owned keys. The partial is always included (it is small);
   * the wrapper dedups by comparing its merged result to the on-disk file.
   */
  async retrieveClaudeSettings(
    host: Host,
    opts: { home?: string | null; username?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select()
      .from(clientConfigDocuments)
      .where(eq(clientConfigDocuments.engine, ENGINE_CLAUDE))
      .orderBy(desc(clientConfigDocuments.id))
      .limit(1);
    // Claude-only lookup. There is deliberately NO codex fallback here: a codex
    // client_config carries a codex `model` (e.g. gpt-5.6-terra) that would otherwise
    // leak into Claude's settings.json. When no claude config exists we still
    // render from an EMPTY base so the managed clx MCP block is injected, but no
    // model (or any other key) is borrowed from codex. (The db-fake test harness
    // ignores WHERE, so filter the engine in JS too — `rows[0]` could be codex.)
    const row = rows.find((r) => r.engine === ENGINE_CLAUDE);
    const settings = row && row.settings && typeof row.settings === 'object' ? row.settings : {};
    const apiKey = this.resolveApiKey(host);
    if (!this.publicBaseUrl || !apiKey) {
      return { status: 'missing', owned_paths: [], partial: {} };
    }
    const managedMcpToken = !host.secure ? (await this.mcpSessions.issue(host.id)).token : null;
    const agentMessagingEnabled = host.secure === 1
      && host.agentMessagingEnabled === 1
      && await this.settings.getFlag(AGENT_MESSAGING_ENABLED_KEY, false);
    const rendered = renderClaudeSettingsPartialForHost({
      settings,
      host,
      baseUrl: this.publicBaseUrl,
      apiKey,
      engine: ENGINE_CLAUDE,
      managedMcpToken,
      home: opts.home ?? null,
      username: opts.username ?? null,
      agentMessagingEnabled,
    });
    await this.recordLog(host.id, 'claude_settings.retrieve', { sha256: rendered.sha256 });
    return {
      status: 'updated',
      sha256: rendered.sha256,
      partial: rendered.partial,
      owned_paths: rendered.owned_paths,
    };
  }

  private resolveApiKey(host: Host): string | null {
    if (this.keyring) {
      const decrypted = decryptOrNull(host.apiKeyEnc, this.keyring);
      if (decrypted) return decrypted;
    }
    const legacy = host.apiKey ?? '';
    return legacy.length === 64 && legacy === host.apiKeyHash ? null : legacy || null;
  }

  /**
   * Resolve the capabilities that are actually usable by this engine/host.
   * The pure renderer below this seam only knows booleans and reasons; all DB,
   * config, host, and engine policy stays here.
   */
  private async resolveManagedFeatureContext(host: Host, engine: Engine): Promise<ManagedAgentFeatureContext> {
    const [configRows, skillCount, projectsEnabled, secretsEnabled, secretCount] =
      await Promise.all([
        this.db
          .select()
          .from(clientConfigDocuments)
          .where(eq(clientConfigDocuments.engine, engine))
          .orderBy(desc(clientConfigDocuments.id))
          .limit(1),
        this.skills.availableCount(engine).catch(() => null),
        this.projects.getEnabled().catch(() => null),
        // Both `.catch(() => null)` for the same reason as their neighbours: a
        // box mid-deploy whose `secrets` table does not exist yet would
        // otherwise 500 every host's bootstrap, not just its guidance block.
        this.secrets.getEnabled().catch(() => null),
        this.secrets.availableCount(engine).catch(() => null),
      ]);
    // db-fake ignores WHERE, so do not borrow another engine's row in tests.
    const configRow = configRows.find((candidate) => candidate.engine === engine) ?? null;
    const rawSettings = configRow?.settings && typeof configRow.settings === 'object'
      ? configRow.settings
      : engine === ENGINE_CLAUDE
        ? {}
        : null;

    const mcp = rawSettings === null
      ? { enabled: false, reason: 'config_missing' as const }
      : managedMcpAvailability({
          settings: normalizeSettings(rawSettings, { applyCodexDefaults: engine === ENGINE_CODEX }),
          host,
          baseUrl: this.publicBaseUrl,
          apiKey: this.resolveApiKey(host),
        });

    const state = (enabled: boolean, reason: string, count?: number): ManagedFeatureState => ({
      enabled,
      reason,
      ...(count === undefined ? {} : { count }),
    });

    const skills = skillCount === null
      ? state(false, 'service_unavailable')
      : skillCount === 0
        ? state(false, 'no_skills', 0)
        : engine === ENGINE_CODEX && !mcp.enabled
          ? state(false, mcp.reason, skillCount)
          : state(true, 'ok', skillCount);
    const memory = state(mcp.enabled, mcp.reason);
    const projects = projectsEnabled === null
      ? state(false, 'service_unavailable')
      : !mcp.enabled
        ? state(false, mcp.reason)
        : projectsEnabled
          ? state(true, 'ok')
          : state(false, 'projects_disabled');
    const browseros = engine !== ENGINE_CODEX
      ? state(false, 'unsupported_engine')
      : !mcp.enabled
        ? state(false, mcp.reason)
        : host.browserosMcpEnabled === 1
          ? state(true, 'ok')
          : state(false, 'host_disabled');

    // An empty enabled store still needs guidance: `secret_store` is how an
    // agent creates its first credential. Count is diagnostic metadata, not an
    // activation gate.
    const secrets =
      secretsEnabled === null || secretCount === null
        ? state(false, 'service_unavailable')
        : !mcp.enabled
          ? state(false, mcp.reason)
          : !secretsEnabled
            ? state(false, 'secrets_disabled')
            : state(true, 'ok', secretCount);

    return { engine, skills, memory, projects, browseros, secrets };
  }

  private async resolveServedDocument(
    host: Host,
    engine: Engine,
    recordMissingOverride = true,
  ): Promise<typeof agentsDocuments.$inferSelect | null> {
    const override = host.agentsDocumentIdOverride;
    if (override && Number(override) > 0) {
      const rows = await this.db
        .select()
        .from(agentsDocuments)
        .where(eq(agentsDocuments.id, Number(override)))
        .limit(1);
      if (rows[0]) return rows[0];
      if (recordMissingOverride) {
        await this.recordLog(host.id, 'agents.host_override_missing', {
          status: 'fallback_latest',
          override_id: Number(override),
        });
      }
    }

    const stateId = engine === ENGINE_CLAUDE ? STATE_ID_CLAUDE : STATE_ID_CODEX;
    const state = await this.db
      .select()
      .from(agentsDocumentState)
      .where(eq(agentsDocumentState.id, stateId))
      .limit(1);
    const mode = state[0]?.mode ?? 'latest';
    const activeId = state[0]?.activeDocumentId ?? null;
    if (mode === MODE_LOCKED && activeId !== null) {
      const active = await this.db.select().from(agentsDocuments).where(eq(agentsDocuments.id, Number(activeId))).limit(1);
      if (active[0]) return active[0];
    }
    const latestEngine = await this.db
      .select()
      .from(agentsDocuments)
      .where(eq(agentsDocuments.engine, engine))
      .orderBy(desc(agentsDocuments.id))
      .limit(1);
    if (latestEngine[0]) return latestEngine[0];
    const latest = await this.db.select().from(agentsDocuments).orderBy(desc(agentsDocuments.id)).limit(1);
    return latest[0] ?? null;
  }

  private async recordLog(hostId: number | null, action: string, details: Record<string, unknown>): Promise<void> {
    await this.db.insert(logs).values({
      hostId: hostId ?? null,
      action,
      details: JSON.stringify(details),
      createdAt: nowIso(),
      engine: null,
    });
  }
}

function safeHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
