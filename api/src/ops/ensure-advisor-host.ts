/**
 * Provision the Fleet Advisor's server-owned host at boot.
 *
 * The `advisor` compose container is part of this stack, not a fleet machine:
 * nobody registers it, picks it or sees it. This step makes sure exactly one
 * `internal_role = 'advisor'` host exists with an enabled daemon, and writes its
 * credential where the container (and only it) can read it. Idempotent; it
 * never rotates an existing key, because the container's signed configs and
 * native transcripts live on in its volume.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { hostDaemons, hostSpawns, hosts, versions, type Host } from '../db/schema.js';
import { decryptOrNull, encrypt } from '../security/secret-box.js';
import { sha256 } from '../security/hash.js';
import { nowIso } from '../util/timestamp.js';
import { ENGINES } from '../util/engine.js';
import { ADVISOR_FQDN, ADVISOR_ROLE } from '../services/internal-hosts.js';
import { HostDaemonService } from '../services/host-daemon/service.js';
import { daemonSettingsSchema } from '../services/host-daemon/policy.js';

/** v1 stored the operator-picked advisor host here; adopted once, then removed. */
const LEGACY_ADVISOR_SETTINGS_KEY = 'advisor_settings';

export interface AdvisorHostBootstrapResult {
  status: 'created' | 'adopted' | 'present';
  host_id: number;
  bootstrap: 'written' | 'unchanged' | 'skipped' | 'unwritable';
}

async function adoptLegacy(db: Database): Promise<Host | null> {
  const [row] = await db.select().from(versions).where(eq(versions.name, LEGACY_ADVISOR_SETTINGS_KEY)).limit(1);
  if (!row?.version) return null;
  let hostId: unknown;
  try {
    hostId = (JSON.parse(row.version) as { host_id?: unknown }).host_id;
  } catch {
    hostId = null;
  }
  const [host] = typeof hostId === 'number'
    ? await db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1)
    : [];
  await db.transaction(async (tx) => {
    if (host) {
      await tx
        .update(hosts)
        .set({ internalRole: ADVISOR_ROLE, fqdn: ADVISOR_FQDN, updatedAt: nowIso() })
        .where(eq(hosts.id, host.id));
      await tx.delete(hostSpawns).where(eq(hostSpawns.targetHostId, host.id));
    }
    await tx.delete(versions).where(eq(versions.name, LEGACY_ADVISOR_SETTINGS_KEY));
  });
  if (!host) return null;
  const [adopted] = await db.select().from(hosts).where(eq(hosts.id, host.id)).limit(1);
  return adopted ?? null;
}

async function create(db: Database, keyring: Keyring): Promise<Host> {
  const apiKey = `sk-codex-${randomBytes(32).toString('hex')}`;
  const apiKeyHash = sha256(apiKey);
  const now = nowIso();
  await db.insert(hosts).values({
    fqdn: ADVISOR_FQDN,
    apiKey: apiKeyHash,
    apiKeyHash,
    apiKeyEnc: encrypt(apiKey, keyring),
    status: 'active',
    secure: 1,
    // A bridge-network address changes when the container is recreated and
    // has no PTR record.
    allowRoamingIps: 1,
    reverseDnsMode: 0,
    engines: ENGINES.join(','),
    internalRole: ADVISOR_ROLE,
    createdAt: now,
    updatedAt: now,
  });
  const [host] = await db.select().from(hosts).where(eq(hosts.fqdn, ADVISOR_FQDN)).limit(1);
  return host!;
}

/** Write `<DATA_ROOT>/advisor/bootstrap.json` (0600) only when its content changes. */
async function writeBootstrap(env: Env, host: Host, keyring: Keyring): Promise<AdvisorHostBootstrapResult['bootstrap']> {
  const apiKey = decryptOrNull(host.apiKeyEnc, keyring);
  const baseUrl = env.PUBLIC_BASE_URL ?? env.CODEX_SYNC_BASE_URL;
  if (!env.DATA_ROOT || !apiKey || !baseUrl) return 'skipped';
  const dir = join(env.DATA_ROOT, 'advisor');
  const path = join(dir, 'bootstrap.json');
  const body = `${JSON.stringify({ fqdn: host.fqdn, api_key: apiKey, base_url: baseUrl.replace(/\/+$/, '') })}\n`;
  if ((await readFile(path, 'utf8').catch(() => null)) === body) return 'unchanged';
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(`${path}.tmp`, body, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    return 'written';
  } catch {
    // deploy.sh / install.sh create store/advisor owned by uid 10001.
    return 'unwritable';
  }
}

export async function ensureAdvisorHost(db: Database, env: Env, keyring: Keyring): Promise<AdvisorHostBootstrapResult> {
  let status: AdvisorHostBootstrapResult['status'] = 'present';
  let [host] = await db.select().from(hosts).where(eq(hosts.internalRole, ADVISOR_ROLE)).limit(1);
  if (!host) {
    const adopted = await adoptLegacy(db);
    if (adopted) {
      host = adopted;
      status = 'adopted';
    } else {
      host = await create(db, keyring);
      status = 'created';
    }
  }
  if (host.status !== 'active' || host.fqdn !== ADVISOR_FQDN || host.secure !== 1 || host.engines !== ENGINES.join(',')) {
    // Every engine, so callers may pick any the fleet has enabled.
    await db
      .update(hosts)
      .set({ status: 'active', fqdn: ADVISOR_FQDN, secure: 1, allowRoamingIps: 1, reverseDnsMode: 0, expiresAt: null, engines: ENGINES.join(','), updatedAt: nowIso() })
      .where(eq(hosts.id, host.id));
    [host] = await db.select().from(hosts).where(eq(hosts.id, host.id)).limit(1);
  }
  const [daemon] = await db.select().from(hostDaemons).where(eq(hostDaemons.hostId, host!.id)).limit(1);
  const wanted = {
    enabled: true,
    username: 'advisor',
    default_cwd: '/work',
    max_parallel: env.ADVISOR_MAX_PARALLEL,
    idle_minutes: 60,
  };
  const current = daemon?.settings;
  if (
    !current ||
    current.enabled !== wanted.enabled ||
    current.username !== wanted.username ||
    current.default_cwd !== wanted.default_cwd ||
    current.max_parallel !== wanted.max_parallel ||
    current.idle_minutes !== wanted.idle_minutes ||
    current.lifetime_minutes
  ) {
    await new HostDaemonService({ db, env, keyring }).configure(
      host!.id,
      daemonSettingsSchema.parse({ ...wanted, lifetime_minutes: null, question_minutes: current?.question_minutes ?? 1440 }),
    );
  }
  return { status, host_id: host!.id, bootstrap: await writeBootstrap(env, host!, keyring) };
}
