import { eq } from 'drizzle-orm';
import { authSeedTokens, installTokens } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { decryptOrNull } from '../security/secret-box.js';
import { sha256 } from '../security/hash.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../util/engine.js';
import { buildWrapperV2InstallerScript } from './wrapper-transition.js';

/**
 * Install + auth-seed token lookup, expiry checks, mark-used. Plus shell
 * script builders so the route layer can return bash without inlining the
 * heredocs by hand.
 */

export interface InstallTokenRow {
  id: number;
  token: string;
  hostId: number;
  fqdn: string;
  apiKey: string;
  baseUrl: string | null;
  expiresAt: string;
  usedAt: string | null;
  engine: Engine;
}

export interface SeedTokenRow {
  id: number;
  token: string;
  baseUrl: string | null;
  expiresAt: string;
  usedAt: string | null;
  engine: Engine;
}

export interface InstallTokenService {
  findInstall(token: string): Promise<InstallTokenRow | null>;
  markInstallUsed(id: number): Promise<void>;
  findSeed(token: string): Promise<SeedTokenRow | null>;
  markSeedUsed(id: number): Promise<void>;
}

export interface InstallTokenDeps {
  db: Database;
  keyring?: Keyring;
}

function asEngine(value: string | null | undefined): Engine {
  return value === ENGINE_CLAUDE ? ENGINE_CLAUDE : ENGINE_CODEX;
}

function looksLikeSha256(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function createInstallTokenService(deps: InstallTokenDeps): InstallTokenService {
  const { db } = deps;
  return {
    async findInstall(token) {
      const tokenHash = sha256(token);
      let rows = await db.select().from(installTokens).where(eq(installTokens.token, tokenHash)).limit(1);
      if (!rows[0]) {
        rows = await db.select().from(installTokens).where(eq(installTokens.token, token)).limit(1);
      }
      const r = rows[0];
      if (!r) return null;
      const decryptedApiKey = deps.keyring ? decryptOrNull(r.apiKeyEnc ?? null, deps.keyring) : null;
      const apiKey = decryptedApiKey ?? (looksLikeSha256(r.apiKey) ? '' : r.apiKey);
      return {
        id: r.id,
        token,
        hostId: r.hostId,
        fqdn: r.fqdn,
        apiKey,
        baseUrl: r.baseUrl ?? null,
        expiresAt: r.expiresAt,
        usedAt: r.usedAt ?? null,
        engine: asEngine(r.engine),
      };
    },
    async markInstallUsed(id) {
      await db.update(installTokens).set({ usedAt: nowIso() }).where(eq(installTokens.id, id));
    },
    async findSeed(token) {
      const tokenHash = sha256(token);
      let rows = await db.select().from(authSeedTokens).where(eq(authSeedTokens.token, tokenHash)).limit(1);
      if (!rows[0]) {
        rows = await db.select().from(authSeedTokens).where(eq(authSeedTokens.token, token)).limit(1);
      }
      const r = rows[0];
      if (!r) return null;
      const tokenPlain = deps.keyring ? (decryptOrNull(r.tokenEnc ?? null, deps.keyring) ?? token) : token;
      return {
        id: r.id,
        token: tokenPlain,
        baseUrl: r.baseUrl ?? null,
        expiresAt: r.expiresAt,
        usedAt: r.usedAt ?? null,
        engine: asEngine(r.engine),
      };
    },
    async markSeedUsed(id) {
      await db.update(authSeedTokens).set({ usedAt: nowIso() }).where(eq(authSeedTokens.id, id));
    },
  };
}

export function tokenExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t < Date.now();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildInstallerScript(opts: {
  fqdn: string;
  apiKey: string;
  baseUrl: string;
  engine: Engine;
}): string {
  return buildWrapperV2InstallerScript(opts);
}

export function buildSeedAuthScript(opts: { baseUrl: string; token: string; engine: Engine }): string {
  const token = opts.token.trim();
  if (!token) throw new Error('Seed token missing');
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  if (!baseUrl || baseUrl === 'http:' || baseUrl === 'https:') {
    throw new Error('Seed base URL invalid');
  }
  const postUrl = `${baseUrl}/seed/v2/auth/${token}`;
  const authPath =
    opts.engine === ENGINE_CLAUDE ? '$HOME/.claude/.credentials.json' : '$HOME/.codex/auth.json';
  const label = opts.engine === ENGINE_CLAUDE ? 'Claude credentials' : 'Codex auth.json';
  const postUrlQ = shellQuote(postUrl);
  return `#!/bin/sh
# Codex Orchestrator wrapper-v2 seed-auth uploader (${opts.engine}).
set -eu

AUTH_PATH=${authPath}
if [ ! -f "$AUTH_PATH" ]; then
  echo "${label} not found at $AUTH_PATH" >&2
  exit 1
fi

echo ">> Uploading ${label} to orchestrator"
curl -fsSL -X POST \\
  -H "Content-Type: application/json" \\
  --data-binary @"$AUTH_PATH" \\
  -o /tmp/seed-auth-response.json \\
  ${postUrlQ} || { echo "Upload failed; see /tmp/seed-auth-response.json" >&2; exit 1; }

echo "Done. Server response:"
cat /tmp/seed-auth-response.json
echo
`;
}

export function shellErrorScript(message: string): string {
  return `echo "${message.replace(/"/g, '\\"')}" >&2\nexit 1\n`;
}
