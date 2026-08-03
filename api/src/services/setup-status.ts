import { and, eq } from 'drizzle-orm';
import { join, resolve } from 'node:path';
import type { Database } from '../db/client.js';
import {
  adminUsers,
  authCanonicalHeads,
  authPayloads,
  hosts,
  schemaMigrations,
  wrapperSigningKeys,
} from '../db/schema.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { isEnvelope } from '../security/secret-box.js';
import { loadMigrations } from '../db/migrator.js';
import {
  CXX_ARTIFACT,
  SUPPORTED_WRAPPER_PLATFORMS,
  createWrapperBinRegistry,
} from './wrapper-bin-registry.js';
import { createWrapperSigningKeyService } from './wrapper-signing-key.js';
import { parseEnginesInput } from './host-management.js';
import { createSetupWizardService, type SetupWizardState } from './setup-wizard.js';
import { ENGINE_CODEX } from '../util/engine.js';

export interface SetupCheck {
  id: string;
  label: string;
  ok: boolean;
  critical: boolean;
  detail: string;
}

export interface SetupStatus {
  critical_complete: boolean;
  owner_created: boolean;
  setup_complete: boolean;
  checks: SetupCheck[];
  configured_engines: string[];
  canonical_auth: { codex: boolean; claude: boolean };
  hosts: { total: number; synced: number };
  public_base_url: string | null;
  warnings: string[];
  next_actions: Array<{ id: string; complete: boolean; label: string; href: string }>;
  /**
   * First-run wizard progress. Separate from `setup_complete`, which only
   * covers infrastructure and the owner claim and therefore goes true at step
   * two of nine. See `setup-wizard.ts`.
   */
  wizard: SetupWizardState;
}

export class SetupStatusService {
  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly keyring: Keyring,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async status(requestOrigin?: string | null): Promise<SetupStatus> {
    const [migrations, runner, signer, wrappers, users, codexAuth, claudeAuth, hostRows, wizard] =
      await Promise.all([
        this.migrationCheck(),
        this.runnerCheck(),
        this.signerCheck(),
        this.wrapperCheck(),
        this.db.select({ id: adminUsers.id }).from(adminUsers),
        this.hasCanonicalAuth('codex'),
        this.hasCanonicalAuth('claude'),
        this.db
          .select({ id: hosts.id, codex: hosts.lastRefresh, claude: hosts.claudeLastRefresh })
          .from(hosts),
        // Carried here so the dashboard resume card and the wizard itself can
        // decide what to show from one request instead of two.
        createSetupWizardService(this.db).get(),
      ]);

    const publicBaseUrl = normalizePublicUrl(this.env.PUBLIC_BASE_URL);
    const checks: SetupCheck[] = [
      { id: 'database', label: 'Database', ok: true, critical: true, detail: 'query succeeded' },
      migrations,
      runner,
      signer,
      wrappers,
      {
        id: 'public_base_url',
        label: 'Public Base URL',
        ok: publicBaseUrl !== null,
        critical: true,
        detail: publicBaseUrl ? 'configured' : 'missing or invalid HTTP(S) URL',
      },
    ];
    const criticalComplete = checks.filter((check) => check.critical).every((check) => check.ok);
    const ownerCreated = users.length > 0;
    const syncedHosts = hostRows.filter((row) => Boolean(row.codex || row.claude)).length;
    const configuredEngines = parseEnginesInput(this.env.DEFAULT_HOST_ENGINES, [ENGINE_CODEX]);
    const warnings: string[] = [];
    if (publicBaseUrl && requestOrigin && normalizeOrigin(requestOrigin) !== normalizeOrigin(publicBaseUrl)) {
      warnings.push(`Browser origin ${normalizeOrigin(requestOrigin)} differs from PUBLIC_BASE_URL ${normalizeOrigin(publicBaseUrl)}.`);
    }
    if (!ownerCreated) warnings.push('The first-owner claim is open. Do not expose this installation publicly until an owner is created.');

    const nextActions = [
      ...configuredEngines.map((engine) => ({
        id: `auth_${engine}`,
        complete: engine === 'claude' ? claudeAuth : codexAuth,
        label: `Seed canonical ${engine === 'claude' ? 'Claude' : 'Codex'} authentication`,
        // The wizard's auth step, not /admin/api-keys — that page manages proxy
        // bearer keys and has never had any canonical-auth UI, so this link
        // used to send the operator somewhere the task could not be done.
        href: '/admin/setup?step=auth',
      })),
      { id: 'first_host', complete: hostRows.length > 0, label: 'Register the first host', href: '/admin/hosts?dialog=new-host' },
      { id: 'first_sync', complete: syncedHosts > 0, label: 'Confirm the first successful host sync', href: '/admin/hosts' },
    ];

    return {
      critical_complete: criticalComplete,
      owner_created: ownerCreated,
      setup_complete: criticalComplete && ownerCreated,
      checks,
      configured_engines: configuredEngines,
      canonical_auth: { codex: codexAuth, claude: claudeAuth },
      hosts: { total: hostRows.length, synced: syncedHosts },
      public_base_url: publicBaseUrl,
      warnings,
      next_actions: nextActions,
      wizard,
    };
  }

  private async migrationCheck(): Promise<SetupCheck> {
    try {
      const [files, applied] = await Promise.all([
        loadMigrations(this.env.MIGRATIONS_DIR),
        this.db.select().from(schemaMigrations),
      ]);
      const ledger = new Map(applied.map((row) => [row.version, row.checksum]));
      const pending = files.filter((file) => !ledger.has(file.version));
      const drifted = files.filter((file) => ledger.has(file.version) && ledger.get(file.version) !== file.checksum);
      const ok = pending.length === 0 && drifted.length === 0;
      return {
        id: 'migrations', label: 'Migrations', ok, critical: true,
        detail: ok ? `${files.length} applied` : `${pending.length} pending, ${drifted.length} drifted`,
      };
    } catch (error) {
      return { id: 'migrations', label: 'Migrations', ok: false, critical: true, detail: safeError(error) };
    }
  }

  private async runnerCheck(): Promise<SetupCheck> {
    const raw = this.env.AUTH_RUNNER_URL?.trim();
    if (!raw || !this.env.AUTH_RUNNER_SHARED_SECRET) {
      return { id: 'runner', label: 'Auth runner', ok: false, critical: true, detail: 'runner URL or shared secret missing' };
    }
    const healthUrl = raw.replace(/\/verify(?:\?.*)?$/, '/health');
    try {
      const response = await this.fetchImpl(healthUrl, { signal: AbortSignal.timeout(Math.max(1000, (this.env.AUTH_RUNNER_TIMEOUT ?? 8) * 1000)) });
      const body = (await response.json().catch(() => null)) as { status?: string } | null;
      const ok = response.ok && body?.status === 'ok';
      return { id: 'runner', label: 'Auth runner', ok, critical: true, detail: ok ? 'healthy' : `health returned HTTP ${response.status}` };
    } catch {
      return { id: 'runner', label: 'Auth runner', ok: false, critical: true, detail: 'runner health request failed' };
    }
  }

  private async signerCheck(): Promise<SetupCheck> {
    // Several keys may be active at once during a rotation; all of them sign,
    // so the check passes only when every active row is encrypted and loadable.
    const activeRows = await this.db.select().from(wrapperSigningKeys).where(eq(wrapperSigningKeys.active, 1));
    const encrypted = activeRows.length > 0 && activeRows.every((row) => isEnvelope(row.privateKeyEnc));
    const signers = encrypted
      ? await createWrapperSigningKeyService({ db: this.db, keyring: this.keyring }).allActive()
      : [];
    const ok = encrypted && signers.length === activeRows.length;
    return {
      id: 'signer', label: 'Wrapper signer', ok, critical: true,
      detail: ok
        ? signers.length === 1
          ? `active key ${signers[0]!.kid}`
          : `${signers.length} active keys, primary ${signers[0]!.kid}`
        : activeRows.length === 0
          ? 'no active encrypted signing key'
          : `${activeRows.length - signers.length} of ${activeRows.length} active signing keys unusable`,
    };
  }

  private async wrapperCheck(): Promise<SetupCheck> {
    const binRoot = this.env.DATA_ROOT
      ? join(this.env.DATA_ROOT, 'wrapper', 'v2', 'bin')
      : resolve(import.meta.dirname, '..', '..', '..', '..', 'storage', 'wrapper', 'v2', 'bin');
    const registry = createWrapperBinRegistry({ binRoot });
    const versions = new Set<string>();
    for (const platform of SUPPORTED_WRAPPER_PLATFORMS) {
      const manifest = await registry.manifestForPlatform(CXX_ARTIFACT, platform);
      const build = manifest?.builds.find((candidate) => candidate.version === manifest.current);
      if (!manifest || !build) return wrapperFailure(`${platform} manifest missing or invalid`);
      const [os, arch] = platform.split('-');
      const descriptor = await registry.binaryDescriptor(CXX_ARTIFACT, os!, arch!, build.version);
      if (!descriptor || descriptor.sha256 !== build.sha256 || descriptor.size !== build.size_bytes) {
        return wrapperFailure(`${platform} artifact missing or checksum mismatch`);
      }
      versions.add(build.version);
    }
    if (versions.size !== 1) return wrapperFailure('platform artifacts use mixed versions');
    return { id: 'wrappers', label: 'Wrapper platform matrix', ok: true, critical: true, detail: `4 platforms at ${[...versions][0]}` };
  }

  private async hasCanonicalAuth(engine: 'codex' | 'claude'): Promise<boolean> {
    const heads = await this.db
      .select({ payloadId: authCanonicalHeads.payloadId })
      .from(authCanonicalHeads)
      .where(eq(authCanonicalHeads.engine, engine));
    const payloadId = heads[0]?.payloadId;
    if (payloadId === undefined) return false;
    const rows = await this.db
      .select({ id: authPayloads.id })
      .from(authPayloads)
      .where(and(
        eq(authPayloads.id, payloadId),
        eq(authPayloads.engine, engine),
        eq(authPayloads.verificationState, 'verified'),
      ));
    return rows.length > 0;
  }
}

function wrapperFailure(detail: string): SetupCheck {
  return { id: 'wrappers', label: 'Wrapper platform matrix', ok: false, critical: true, detail };
}

function normalizePublicUrl(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().replace(/\/$/, '') : null;
  } catch { return null; }
}

function normalizeOrigin(raw: string): string {
  try { return new URL(raw).origin; } catch { return raw.replace(/\/+$/, ''); }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

export function createSetupStatusService(db: Database, env: Env, keyring: Keyring): SetupStatusService {
  return new SetupStatusService(db, env, keyring);
}
