import { eq } from 'drizzle-orm';
import { authSeedTokens, installTokens } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../util/engine.js';

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
}

function asEngine(value: string | null | undefined): Engine {
  return value === ENGINE_CLAUDE ? ENGINE_CLAUDE : ENGINE_CODEX;
}

export function createInstallTokenService(deps: InstallTokenDeps): InstallTokenService {
  const { db } = deps;
  return {
    async findInstall(token) {
      const rows = await db.select().from(installTokens).where(eq(installTokens.token, token)).limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        token: r.token,
        hostId: r.hostId,
        fqdn: r.fqdn,
        apiKey: r.apiKey,
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
      const rows = await db.select().from(authSeedTokens).where(eq(authSeedTokens.token, token)).limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        token: r.token,
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
  if (!opts.apiKey) throw new Error('Installer host API key missing');
  if (!opts.fqdn) throw new Error('Installer host FQDN missing');
  const name = opts.engine === ENGINE_CLAUDE ? 'clx' : 'cdx';
  const cliName = opts.engine === ENGINE_CLAUDE ? 'claude' : 'codex';
  const apiKeyQ = shellQuote(opts.apiKey);
  const baseUrlQ = shellQuote(opts.baseUrl.replace(/\/+$/, ''));
  const fqdnQ = shellQuote(opts.fqdn);
  const cliHint =
    opts.engine === ENGINE_CLAUDE
      ? `command -v ${cliName} >/dev/null 2>&1 || echo ">> Install Claude CLI manually (e.g. npm install -g @anthropic-ai/claude-code) and re-run."`
      : `command -v ${cliName} >/dev/null 2>&1 || echo ">> Install Codex CLI manually (e.g. via the upstream installer) and re-run."`;
  return `#!/bin/sh
# Codex Orchestrator wrapper-v2 installer for ${name}.
# Generated for host ${fqdnQ}.
set -eu

BASE_URL=${baseUrlQ}
HOST_API_KEY=${apiKeyQ}
BIN_DIR=\${BIN_DIR:-$HOME/.local/bin}
mkdir -p "$BIN_DIR"
echo ">> Installing the ${name} wrapper into $BIN_DIR"

# 1. Friendly engine CLI hint (the wrapper invokes this binary).
${cliHint}

# 2. Download the engine-specific bootstrap shim from the orchestrator.
curl -fsSL "$BASE_URL/wrapper/v2/download?engine=${opts.engine}" -o "$BIN_DIR/${name}" || {
  echo "Failed to download wrapper from $BASE_URL/wrapper/v2/download" >&2
  exit 1
}
chmod +x "$BIN_DIR/${name}"

# 3. First sync — pulls the signed config + the platform-specific binary.
echo ">> First sync"
"$BIN_DIR/${name}" status || true

echo
echo "Done. Try: ${name} run    (or ${name} doctor for a self-check)."
`;
}

export function buildSeedAuthScript(opts: { baseUrl: string; token: string; engine: Engine }): string {
  const token = opts.token.trim();
  if (!token) throw new Error('Seed token missing');
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  if (!baseUrl || baseUrl === 'http:' || baseUrl === 'https:') {
    throw new Error('Seed base URL invalid');
  }
  const postUrl = `${baseUrl}/seed/v2/auth/${token}`;
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

export function shellErrorScript(message: string): string {
  return `echo "${message.replace(/"/g, '\\"')}" >&2\nexit 1\n`;
}
