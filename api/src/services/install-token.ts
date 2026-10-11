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
  return `#!/bin/sh
# Codex Orchestrator wrapper-v2 seed-auth uploader (grok).
set -eu
command -v python3 >/dev/null 2>&1 || { echo "python3 is required for private Grok seed cleanup" >&2; exit 1; }
exec python3 - ${shellQuote(postUrl)} <<'CXX_GROK_SEED_PY'
import os, pathlib, shutil, subprocess, sys, tempfile, time

post_url = sys.argv[1]
existing = os.environ.get('GROK_SEED_AUTH_PATH', '')
private = None
lease = None
reaper = None

def active(path):
    # A native process may close the inherited pipe; its private environment
    # independently fences cleanup until that process has exited.
    if pathlib.Path('/proc').is_dir():
        for entry in pathlib.Path('/proc').iterdir():
            if not entry.name.isdigit() or int(entry.name) == os.getpid():
                continue
            try:
                env = (entry / 'environ').read_bytes().split(bytes([0]))
            except (OSError, PermissionError):
                continue
            for item in env:
                key, sep, value = item.partition(b'=')
                if key in (b'GROK_HOME', b'GROK_AUTH_PATH') and (value == os.fsencode(path) or value.startswith(os.fsencode(path + '/'))):
                    return True
        return False
    try:
        rows = subprocess.check_output(['ps', 'eww', '-U', str(os.getuid()), '-o', 'command='], stderr=subprocess.DEVNULL).decode()
        return 'GROK_HOME=' + path in rows or 'GROK_AUTH_PATH=' + path in rows
    except (OSError, subprocess.CalledProcessError):
        return True

try:
    if existing:
        auth_path = existing
        if not pathlib.Path(auth_path).is_file():
            raise RuntimeError('Grok subscription credentials not found')
        print('!! Uploading an existing Grok login; do not use it elsewhere after upload.', file=sys.stderr)
        env = dict(os.environ)
    else:
        hint = pathlib.Path.home() / '.cgx/state/grok-bin'
        binary = hint.read_text().strip() if hint.is_file() else ''
        if not binary or not os.access(binary, os.X_OK):
            binary = shutil.which('grok')
        if not binary:
            raise RuntimeError('Grok CLI not found; install cgx (or the official grok CLI), or set GROK_SEED_AUTH_PATH')
        private = tempfile.mkdtemp(prefix='cgx-seed-')
        read_fd, lease = os.pipe()
        ack_read, ack_write = os.pipe()
        reaper = os.fork()
        if reaper == 0:
            os.setsid()
            os.close(lease)
            os.close(ack_read)
            # Detach terminal/pipeline handles before acknowledging readiness.
            null = os.open(os.devnull, os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(null, fd)
            os.close(null)
            os.write(ack_write, b'1')
            os.close(ack_write)
            while os.read(read_fd, 4096):
                pass
            os.close(read_fd)
            while active(private):
                time.sleep(0.1)
            shutil.rmtree(private)
            os._exit(0)
        os.close(read_fd)
        os.close(ack_write)
        if os.read(ack_read, 1) != b'1':
            raise RuntimeError('Grok seed cleanup helper did not become ready')
        os.close(ack_read)
        env = dict(os.environ)
        for key in ('GROK_API_KEY', 'XAI_API_KEY', 'GROK_AUTH', 'GROK_AUTH_PROVIDER_COMMAND'):
            env.pop(key, None)
        env.update(GROK_HOME=private, GROK_AUTH_PATH=private + '/auth.json', GROK_DISABLE_API_KEY_AUTH='1')
        print('>> Starting a dedicated Grok subscription login; the orchestrator will own its refresh', flush=True)
        try:
            login_in = open('/dev/tty', 'rb')
        except OSError:
            login_in = open(os.devnull, 'rb')
        with login_in:
            subprocess.run([binary, 'login', '--device-auth'], stdin=login_in, env=env, pass_fds=(lease,), check=True)
        auth_path = private + '/auth.json'
        if not pathlib.Path(auth_path).is_file():
            raise RuntimeError('Grok login did not produce credentials')
    print('>> Uploading Grok subscription credentials to orchestrator', flush=True)
    response = tempfile.NamedTemporaryFile(prefix='cgx-seed-response-', delete=False)
    response.close()
    try:
        subprocess.run(['curl', '-fsSL', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@' + auth_path, '-o', response.name, post_url], env=env, pass_fds=(() if lease is None else (lease,)), check=True)
        print('Done. Server response:')
        print(pathlib.Path(response.name).read_text())
    finally:
        os.unlink(response.name)
except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
finally:
    if lease is not None:
        os.close(lease)
        if reaper is not None:
            os.waitpid(reaper, 0)
        elif private is not None:
            shutil.rmtree(private)
CXX_GROK_SEED_PY
`;
}

export function shellErrorScript(message: string): string {
  return `echo "${message.replace(/"/g, '\\"')}" >&2\nexit 1\n`;
}
