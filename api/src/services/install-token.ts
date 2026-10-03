import { and, eq, isNull } from 'drizzle-orm';
import { authSeedTokens, installTokens } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { decryptOrNull } from '../security/secret-box.js';
import { sha256 } from '../security/hash.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CLAUDE, ENGINE_GROK, parseEngine } from '../util/engine.js';
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
  accountId?: number | null;
  id: number;
  token: string;
  baseUrl: string | null;
  expiresAt: string;
  usedAt: string | null;
  engine: Engine;
}

export interface InstallTokenService {
  findInstall(token: string): Promise<InstallTokenRow | null>;
  /** Atomically claims the token (WHERE usedAt IS NULL). Returns false if it was already used. */
  markInstallUsed(id: number): Promise<boolean>;
  findSeed(token: string): Promise<SeedTokenRow | null>;
  /** Atomically claims the token (WHERE usedAt IS NULL). Returns false if it was already used. */
  markSeedUsed(id: number): Promise<boolean>;
  /** Releases a claim after a failed store so the single-use token can retry. */
  releaseSeed(id: number): Promise<void>;
}

export interface InstallTokenDeps {
  db: Database;
  keyring?: Keyring;
}

function asEngine(value: string | null | undefined): Engine {
  return parseEngine(value);
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
      const result = await db
        .update(installTokens)
        .set({ usedAt: nowIso() })
        .where(and(eq(installTokens.id, id), isNull(installTokens.usedAt)));
      return Number(result[0]?.affectedRows ?? 0) > 0;
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
        accountId: r.accountId ?? null,
        engine: asEngine(r.engine),
      };
    },
    async markSeedUsed(id) {
      const result = await db
        .update(authSeedTokens)
        .set({ usedAt: nowIso() })
        .where(and(eq(authSeedTokens.id, id), isNull(authSeedTokens.usedAt)));
      return Number(result[0]?.affectedRows ?? 0) > 0;
    },
    async releaseSeed(id) {
      await db.update(authSeedTokens).set({ usedAt: null }).where(eq(authSeedTokens.id, id));
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
  enginesList?: Engine[];
  allowInsecure?: boolean;
}): string {
  return buildWrapperV2InstallerScript({
    ...opts,
    allowInsecure: opts.allowInsecure ?? false,
    peerEngines: (opts.enginesList ?? []).filter((e) => e !== opts.engine),
  });
}

export function buildSeedAuthScript(opts: { baseUrl: string; token: string; engine: Engine }): string {
  const token = opts.token.trim();
  if (!token) throw new Error('Seed token missing');
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  if (!baseUrl || baseUrl === 'http:' || baseUrl === 'https:') {
    throw new Error('Seed base URL invalid');
  }
  const postUrl = `${baseUrl}/seed/v2/auth/${token}`;
  if (opts.engine === ENGINE_GROK) return buildGrokSeedAuthScript(postUrl);
  const authPath = opts.engine === ENGINE_CLAUDE ? '$HOME/.claude/.credentials.json' : '$HOME/.codex/auth.json';
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

/**
 * xAI rotates the refresh token on every refresh, and the orchestrator is the
 * only party allowed to spend the canonical one. Copying an operator's live
 * `~/.grok/auth.json` would leave two refreshers on one token chain: whichever
 * refreshes second is rejected with `invalid_grant`. So the default seed runs a
 * dedicated device login in a throwaway GROK_HOME (the same isolation as
 * `cgx login`) and erases it after upload. `GROK_SEED_AUTH_PATH` uploads an
 * existing file instead, for a login that will not be used anywhere else.
 */
function buildGrokSeedAuthScript(postUrl: string): string {
  const postUrlQ = shellQuote(postUrl);
  return `#!/bin/sh
# Codex Orchestrator wrapper-v2 seed-auth uploader (grok).
set -eu

SEED_HOME=
cleanup() { if [ -n "$SEED_HOME" ]; then rm -rf "$SEED_HOME"; fi; }
trap cleanup EXIT INT TERM

if [ -n "\${GROK_SEED_AUTH_PATH:-}" ]; then
  AUTH_PATH=$GROK_SEED_AUTH_PATH
  if [ ! -f "$AUTH_PATH" ]; then
    echo "Grok subscription credentials not found at $AUTH_PATH" >&2
    exit 1
  fi
  echo "!! Uploading an existing Grok login. Do not use it anywhere else afterwards:" >&2
  echo "!! the orchestrator now refreshes it, and xAI rejects the other copy's next refresh." >&2
else
  GROK_BIN=
  if [ -r "$HOME/.cgx/state/grok-bin" ]; then GROK_BIN=$(cat "$HOME/.cgx/state/grok-bin"); fi
  if [ -z "$GROK_BIN" ] || [ ! -x "$GROK_BIN" ]; then GROK_BIN=$(command -v grok 2>/dev/null || true); fi
  if [ -z "$GROK_BIN" ]; then
    echo "Grok CLI not found; install cgx (or the official grok CLI), or set GROK_SEED_AUTH_PATH" >&2
    exit 1
  fi
  SEED_HOME=$(mktemp -d)
  chmod 700 "$SEED_HOME"
  echo ">> Starting a dedicated Grok subscription login; the orchestrator will own its refresh"
  # Readable is not enough: without a controlling terminal opening it fails,
  # and a failed redirect on a special builtin would exit this shell.
  if ( : </dev/tty ) 2>/dev/null; then LOGIN_IN=/dev/tty; else LOGIN_IN=/dev/null; fi
  env -u GROK_API_KEY -u XAI_API_KEY -u GROK_AUTH -u GROK_AUTH_PROVIDER_COMMAND \\
    GROK_HOME="$SEED_HOME" GROK_AUTH_PATH="$SEED_HOME/auth.json" GROK_DISABLE_API_KEY_AUTH=1 \\
    "$GROK_BIN" login --device-auth <"$LOGIN_IN"
  AUTH_PATH=$SEED_HOME/auth.json
  if [ ! -f "$AUTH_PATH" ]; then
    echo "Grok login did not produce credentials" >&2
    exit 1
  fi
fi

echo ">> Uploading Grok subscription credentials to orchestrator"
RESPONSE=$(mktemp)
curl -fsSL -X POST \\
  -H "Content-Type: application/json" \\
  --data-binary @"$AUTH_PATH" \\
  -o "$RESPONSE" \\
  ${postUrlQ} || { echo "Upload failed; see $RESPONSE" >&2; exit 1; }

echo "Done. Server response:"
cat "$RESPONSE"
rm -f "$RESPONSE"
echo
`;
}

export function shellErrorScript(message: string): string {
  return `echo "${message.replace(/"/g, '\\"')}" >&2\nexit 1\n`;
}
