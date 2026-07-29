import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  hosts as hostsTable,
  agentsDocuments,
  agentsDocumentState,
  clientConfigDocuments,
  skills as skillsTable,
  type Host,
} from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CODEX } from '../util/engine.js';
import { nowIso } from '../util/timestamp.js';
import { decryptOrNull } from '../security/secret-box.js';
import type { Keyring } from '../security/keyring.js';
import {
  wrapperBinaryUrl,
  type WrapperBinRegistry,
} from './wrapper-bin-registry.js';
import type { WrapperSigningKeyService } from './wrapper-signing-key.js';
import { hostEnginesList } from './host-engine-policy.js';

/**
 * Per-host wrapper config bakery.
 *
 * Combines: hosts row + active agents document (per engine) + active
 * client_config_document (per engine) + the engine's published skills, plus
 * wrapper binary info from the registry. The result is sha-256'd, signed with
 * the active wrapper key (Ed25519), and persisted into `hosts.config_version`
 * + `hosts.config_baked_at` only when the bake mutates state.
 *
 * The returned `payload` is the canonical JSON object (object form — the
 * route serializes it once with `canonicalStringify`). The returned
 * `signature.value` is base64 of the raw 64-byte Ed25519 signature over the
 * same canonical bytes.
 */

export const WRAPPER_CONFIG_SCHEMA_VERSION = 1;

export interface ConfigSignature {
  algo: 'ed25519';
  value: string;
  kid: string;
}

export interface WrapperConfigPayload {
  schema_version: number;
  engine: Engine;
  issued_at: string;
  expires_at: string | null;
  orchestrator: {
    base_url: string;
    api_key: string;
    ca_bundle_path: string | null;
    allow_insecure: boolean;
    installation_id: string;
  };
  host: {
    id: number;
    fqdn: string;
    secure: boolean;
    browseros_mcp_enabled?: boolean;
    engines: string;
    engines_list: Engine[];
  };
  engine_options: Record<string, unknown>;
  wrapper: {
    version: string;
    track: string;
    auto_update: boolean;
    binary_url: string;
    binary_sha256: string;
  };
  documents: {
    agents: { id: number; sha256: string } | null;
    client_config: { id: number; sha256: string } | null;
  };
  skills: Array<{ slug: string; sha256: string }>;
  config_version: number;
  etag: string;
}

export interface BakeResult {
  payload: WrapperConfigPayload;
  signature: ConfigSignature;
  /** Whether `hosts.config_version` was bumped by this call (vs. served fresh). */
  bumped: boolean;
  /** The (possibly newly-bumped) config_version. */
  configVersion: number;
  /** Canonical JSON the signature is computed against. */
  canonicalJson: string;
}

export interface BakePlatform {
  os: string;
  arch: string;
}

export interface WrapperConfigService {
  /** Bake config for a host. Bumps `config_version` and stamps `config_baked_at`. */
  bakeForHost(
    host: Host,
    engine: Engine,
    publicBaseUrl: string,
    platform?: BakePlatform,
  ): Promise<BakeResult>;
}

export interface WrapperConfigDeps {
  db: Database;
  keyring: Keyring;
  binaries: WrapperBinRegistry;
  signing: WrapperSigningKeyService;
  installationId: string;
  /** Optional overrides for engine-options sourced from version/settings rows. */
  settings?: WrapperConfigSettingsLoader;
}

export interface WrapperConfigSettingsLoader {
  silentFlag(): Promise<boolean>;
  adminThemeHint(): Promise<string | null>;
  autoUpdateDefault(): Promise<boolean>;
  wrapperTrack(): Promise<string>;
}

/** No-op settings loader used when callers don't pass one. */
function defaultSettings(): WrapperConfigSettingsLoader {
  return {
    silentFlag: async () => false,
    adminThemeHint: async () => null,
    autoUpdateDefault: async () => true,
    wrapperTrack: async () => 'stable',
  };
}

export function createWrapperConfigService(deps: WrapperConfigDeps): WrapperConfigService {
  const settings = deps.settings ?? defaultSettings();

  async function activeAgentsDocId(engine: Engine): Promise<number | null> {
    // agents_document_state is a singleton table (id=1) with the active doc id.
    const rows = await deps.db
      .select()
      .from(agentsDocumentState)
      .where(eq(agentsDocumentState.engine, engine))
      .limit(1);
    const state = rows[0];
    if (state && state.activeDocumentId) return state.activeDocumentId;

    // Fallback: latest agents document for this engine
    const latest = await deps.db
      .select()
      .from(agentsDocuments)
      .where(eq(agentsDocuments.engine, engine))
      .orderBy(desc(agentsDocuments.updatedAt))
      .limit(1);
    return latest[0]?.id ?? null;
  }

  async function activeAgentsDocSha(
    engine: Engine,
    hostOverride: number | null,
  ): Promise<{
    id: number;
    sha256: string;
  } | null> {
    const id = hostOverride ?? (await activeAgentsDocId(engine));
    if (!id) return null;
    const rows = await deps.db
      .select()
      .from(agentsDocuments)
      .where(eq(agentsDocuments.id, id))
      .limit(1);
    const r = rows[0];
    return r ? { id: r.id, sha256: r.sha256 } : null;
  }

  async function activeClientConfig(
    engine: Engine,
  ): Promise<{ id: number; sha256: string } | null> {
    const rows = await deps.db
      .select()
      .from(clientConfigDocuments)
      .where(eq(clientConfigDocuments.engine, engine))
      .orderBy(desc(clientConfigDocuments.updatedAt))
      .limit(1);
    const r = rows[0];
    return r ? { id: r.id, sha256: r.sha256 } : null;
  }

  async function activeSkills(engine: Engine): Promise<Array<{ slug: string; sha256: string }>> {
    const rows = await deps.db.select().from(skillsTable).limit(2000);
    return rows
      .filter((s) => {
        if (s.deletedAt) return false;
        const e = s.engine ?? ENGINE_CODEX;
        return e === engine;
      })
      .map((s) => ({ slug: s.slug, sha256: s.sha256 }));
  }

  function resolveApiKey(host: Host): string {
    if (host.apiKey && host.apiKey.length > 0) return host.apiKey;
    const dec = decryptOrNull(host.apiKeyEnc, deps.keyring);
    return dec ?? '';
  }

  function engineOptions(
    host: Host,
    engine: Engine,
    opts: { silent: boolean; adminTheme: string | null },
  ): Record<string, unknown> {
    if (engine === 'claude') {
      return {
        silent: opts.silent,
        claude_model_override: host.claudeModelOverride ?? null,
        admin_theme_hint: opts.adminTheme,
      };
    }
    return {
      silent: opts.silent,
      model_override: host.modelOverride ?? null,
      reasoning_effort_override: host.reasoningEffortOverride ?? null,
      admin_theme_hint: opts.adminTheme,
    };
  }

  async function wrapperBlock(
    engine: Engine,
    publicBaseUrl: string,
    requested?: BakePlatform,
  ) {
    const autoUpdate = await settings.autoUpdateDefault();
    const track = await settings.wrapperTrack();
    const platformsToTry: Array<[string, string]> = requested?.os && requested?.arch
      ? [[requested.os, requested.arch]]
      : [
          ['linux', 'amd64'],
          ['linux', 'arm64'],
          ['darwin', 'arm64'],
          ['darwin', 'amd64'],
        ];
    for (const [os, arch] of platformsToTry) {
      const build = await deps.binaries.resolveCurrentBuild(engine, os, arch);
      if (!build) continue;
      return {
        version: build.version,
        track,
        auto_update: autoUpdate,
        binary_url: wrapperBinaryUrl(publicBaseUrl, build.artifact, os, arch, build.version),
        binary_sha256: build.sha256,
      };
    }
    throw new WrapperBinaryUnavailableError(
      requested
        ? `no validated wrapper binary for ${engine}/${requested.os}-${requested.arch}`
        : `no validated wrapper binary for ${engine}`,
    );
  }

  return {
    async bakeForHost(host, engine, publicBaseUrl, platform) {
      const signer = await deps.signing.active();
      if (!signer) {
        throw new WrapperSigningUnavailableError();
      }

      const apiKey = resolveApiKey(host);
      const issuedAt = nowIso();

      const [agents, clientCfg, skills, silent, adminTheme, wrapper] = await Promise.all([
        activeAgentsDocSha(engine, host.agentsDocumentIdOverride ?? null),
        activeClientConfig(engine),
        activeSkills(engine),
        settings.silentFlag(),
        settings.adminThemeHint(),
        wrapperBlock(engine, publicBaseUrl, platform),
      ]);

      // Bump config_version atomically; the new value becomes part of the
      // payload so the etag/signature change visibly when state changes.
      const newVersion = await bumpConfigVersion(deps.db, host.id);
      const bakedAt = nowIso();

      const draft: Omit<WrapperConfigPayload, 'etag'> = {
        schema_version: WRAPPER_CONFIG_SCHEMA_VERSION,
        engine,
        issued_at: issuedAt,
        expires_at: null,
        orchestrator: {
          base_url: publicBaseUrl.replace(/\/+$/, ''),
          api_key: apiKey,
          ca_bundle_path: null,
          allow_insecure: Boolean(host.curlInsecure),
          installation_id: deps.installationId,
        },
        host: {
          id: host.id,
          fqdn: host.fqdn,
          secure: Boolean(host.secure),
          browseros_mcp_enabled: Boolean(host.browserosMcpEnabled),
          engines: host.engines,
          engines_list: hostEnginesList(host.engines),
        },
        engine_options: engineOptions(host, engine, { silent, adminTheme }),
        wrapper,
        documents: {
          agents,
          client_config: clientCfg,
        },
        skills,
        config_version: newVersion,
      };

      const canonicalForHashing = canonicalStringify(draft);
      const etag = createHash('sha256').update(canonicalForHashing).digest('hex');
      const payload: WrapperConfigPayload = { ...draft, etag } as WrapperConfigPayload;
      const canonicalForSigning = canonicalStringify(payload);
      const sigBytes = signer.sign(canonicalForSigning);
      const signature: ConfigSignature = {
        algo: 'ed25519',
        value: sigBytes.toString('base64'),
        kid: signer.kid,
      };

      await stampBakedAt(deps.db, host.id, newVersion, bakedAt);

      return {
        payload,
        signature,
        bumped: true,
        configVersion: newVersion,
        canonicalJson: canonicalForSigning,
      };
    },
  };
}

export class WrapperSigningUnavailableError extends Error {
  constructor() {
    super('wrapper v2 signing key not configured');
    this.name = 'WrapperSigningUnavailableError';
  }
}

export class WrapperBinaryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WrapperBinaryUnavailableError';
  }
}

async function bumpConfigVersion(db: Database, hostId: number): Promise<number> {
  return db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE locks the row so concurrent bakes for the same
    // host serialize instead of both reading the same `cur` and computing
    // the same `next` (which would stamp two different payloads with an
    // identical config_version).
    const rows = await tx
      .select({ configVersion: hostsTable.configVersion })
      .from(hostsTable)
      .where(eq(hostsTable.id, hostId))
      .for('update')
      .limit(1);
    const cur = rows[0]?.configVersion ?? 0;
    const next = cur + 1;
    await tx.update(hostsTable).set({ configVersion: next }).where(eq(hostsTable.id, hostId));
    return next;
  });
}

async function stampBakedAt(
  db: Database,
  hostId: number,
  configVersion: number,
  bakedAt: string,
): Promise<void> {
  await db
    .update(hostsTable)
    .set({ configBakedAt: bakedAt })
    .where(and(eq(hostsTable.id, hostId), eq(hostsTable.configVersion, configVersion)));
}

/**
 * Tiny canonical-JSON stringifier: sorts object keys recursively, leaves array
 * order intact, uses standard `JSON.stringify` for scalar encoding so the
 * signature input is identical regardless of the order keys happened to land
 * in. NOT a full JCS implementation — sufficient for our flat-ish payload.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}
