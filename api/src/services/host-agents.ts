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
import { renderTomlForHost } from './client-config.js';

const STATE_ID_CODEX = 1;
const STATE_ID_CLAUDE = 2;
const MODE_LOCKED = 'locked';

export class HostAgentsService {
  private readonly publicBaseUrl: string | null;
  private readonly keyring: Keyring | null;
  private readonly mcpSessions: McpSessionService;

  constructor(
    private readonly db: Database,
    deps: { publicBaseUrl?: string | null; keyring?: Keyring | null } = {},
  ) {
    this.publicBaseUrl = deps.publicBaseUrl?.replace(/\/+$/, '') ?? null;
    this.keyring = deps.keyring ?? null;
    this.mcpSessions = new McpSessionService(db);
  }

  async retrieve(providedSha: string | null, host: Host, engine: Engine = ENGINE_CODEX): Promise<Record<string, unknown>> {
    const row = await this.resolveServedDocument(host, engine);
    if (!row) {
      await this.recordLog(host.id, 'agents.retrieve', { status: 'missing' });
      return { status: 'missing' };
    }

    const body = row.body ?? '';
    const baseSha = row.sha256 || createHash('sha256').update(body).digest('hex');
    const status = providedSha && safeHashEquals(baseSha, providedSha) ? 'unchanged' : 'updated';
    const out: Record<string, unknown> = {
      status,
      version_id: Number(row.id),
      sha256: baseSha,
      base_sha256: baseSha,
      managed_sha256: null,
      sections: { skills: { present: false }, memories: { present: false } },
      updated_at: row.updatedAt,
      size_bytes: Buffer.byteLength(body, 'utf8'),
    };
    if (status !== 'unchanged') out['content'] = body;
    await this.recordLog(host.id, 'agents.retrieve', { status });
    return out;
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
    const managedMcpToken = settings && this.publicBaseUrl && apiKey && !Boolean(host.secure)
      ? (await this.mcpSessions.issue(host.id)).token
      : null;
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

  private resolveApiKey(host: Host): string | null {
    if (this.keyring) {
      const decrypted = decryptOrNull(host.apiKeyEnc, this.keyring);
      if (decrypted) return decrypted;
    }
    const legacy = host.apiKey ?? '';
    return legacy.length === 64 && legacy === host.apiKeyHash ? null : legacy || null;
  }

  private async resolveServedDocument(host: Host, engine: Engine): Promise<typeof agentsDocuments.$inferSelect | null> {
    const override = host.agentsDocumentIdOverride;
    if (override && Number(override) > 0) {
      const rows = await this.db
        .select()
        .from(agentsDocuments)
        .where(eq(agentsDocuments.id, Number(override)))
        .limit(1);
      if (rows[0]) return rows[0];
      await this.recordLog(host.id, 'agents.host_override_missing', {
        status: 'fallback_latest',
        override_id: Number(override),
      });
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
