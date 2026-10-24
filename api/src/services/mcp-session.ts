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
import { isoOffsetSeconds, nowIso, parseIso } from '../util/timestamp.js';
import { ownerRuntimeFor, mutateOwnerState, setOwnerRequestPrincipal } from '../control-plane/state/runtime.js';
import { requestHost } from '../control-plane/state/admission.js';
import { UnauthorizedError } from '../http/errors.js';

const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

export class McpSessionService {
  constructor(private readonly db: Database) {}

  async issue(hostId: number, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<{ token: string; expires_at: string }> {
    const token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    const now = nowIso();
    const expires = isoOffsetSeconds(ttlSeconds);
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      await mutateOwnerState(owner,{kind:'mcp.token.issue',principal:`host:${hostId}`,payload:{hostId,hash,expires},prepare(ctx){
        if(!ctx.snapshot.hosts.has(hostId))throw new UnauthorizedError('Host no longer exists');
        const row={token:hash,tokenEnc:null,hostId,expiresAt:expires,createdAt:now,updatedAt:now,lastUsedAt:null};
        ctx.write(async tx=>{const [inserted]=await tx.insert(mcpSessionTokens).values(row);ctx.draft.upsert('mcpSessionTokens',{...row,id:Number(inserted.insertId)});});return null;
      }});
      return {token,expires_at:expires};
    }
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
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      owner.assertOwner();const snapshot=owner.state.snapshot(),row=snapshot.table('mcpSessionTokens').by('token',hash)[0];
      if(!row||!Number.isFinite(Date.parse(row.expiresAt))||Date.parse(row.expiresAt)<=Date.now())return null;
      const host=snapshot.hosts.get(row.hostId);if(!host)return null;
      const policy=(h:typeof host)=>JSON.stringify([h.authFingerprint,h.status,h.secure,h.ip4,h.ip6,h.allowRoamingIps,h.reverseDnsMode,h.insecureEnabledUntil,h.insecureGraceUntil]);
      const proof=policy(host);
      setOwnerRequestPrincipal({principal:`host:${host.id}`,revalidate(state){const current=state.table('mcpSessionTokens').get(row.id),currentHost=state.hosts.get(host.id);if(!current||current.token!==hash||Date.parse(current.expiresAt)<=Date.now()||!currentHost||policy(currentHost)!==proof||currentHost.status!=='active'||currentHost.expiresAt&&Date.parse(currentHost.expiresAt)<=Date.now())throw new UnauthorizedError('MCP authority changed');}});
      return requestHost(host,'');
    }
    const rows = await this.db
      .select()
      .from(mcpSessionTokens)
      .where(eq(mcpSessionTokens.token, hash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const exp = parseIso(row.expiresAt);
    if (!exp || exp.getTime() <= Date.now()) return null;
    const hostRows = await this.db.select().from(hosts).where(eq(hosts.id, Number(row.hostId))).limit(1);
    if (!hostRows[0]) return null;
    await this.db
      .update(mcpSessionTokens)
      .set({ lastUsedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(mcpSessionTokens.id, row.id));
    return hostRows[0];
  }
}
