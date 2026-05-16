/**
 * MCP session-token lifecycle. The `/mcp` POST endpoint accepts a bearer
 * token issued from this service or, as a fallback, a host API key. Tokens
 * live in `mcp_session_tokens` with an 8-hour TTL.
 */
import { eq } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import { mcpSessionTokens, hosts } from '../db/schema.js';
import type { Host } from '../db/schema.js';
import { nowIso, parseIso } from '../util/timestamp.js';

const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

export class McpSessionService {
  constructor(private readonly db: Database) {}

  async issue(hostId: number, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<{ token: string; expires_at: string }> {
    const token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    const now = nowIso();
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await this.db.insert(mcpSessionTokens).values({
      token: hash,
      tokenEnc: null,
      hostId,
      expiresAt: expires,
      createdAt: now,
      updatedAt: now,
    });
    return { token, expires_at: expires };
  }

  async verify(token: string): Promise<Host | null> {
    if (!token) return null;
    const hash = createHash('sha256').update(token).digest('hex');
    const rows = await this.db
      .select()
      .from(mcpSessionTokens)
      .where(eq(mcpSessionTokens.token, hash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const exp = parseIso(row.expiresAt);
    if (!exp || exp.getTime() < Date.now()) return null;
    const hostRows = await this.db.select().from(hosts).where(eq(hosts.id, Number(row.hostId))).limit(1);
    if (!hostRows[0]) return null;
    await this.db
      .update(mcpSessionTokens)
      .set({ lastUsedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(mcpSessionTokens.id, row.id));
    return hostRows[0];
  }
}
