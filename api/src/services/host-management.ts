/**
 * Admin-side host management: register / clear / delete / toggle flags / set
 * version overrides. Mirrors the surface of the legacy PHP AdminHostController
 * plus the AuthService::register path, with one twist: the WS publish + audit
 * write is folded into `admin-events-writer` so the call sites are short.
 */
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import type { Env } from '../env.js';
import { hosts, installTokens, hostAuthDigests, logs } from '../db/schema.js';
import type { Host } from '../db/schema.js';
import { decryptOrNull, encrypt as sboxEncrypt } from '../security/secret-box.js';
import { sha256 } from '../security/hash.js';
import { nowIso, isoOffsetSeconds } from '../util/timestamp.js';
import { ENGINE_CODEX, ENGINE_CLAUDE, type Engine } from '../util/engine.js';
import { NotFoundError, ValidationError, ApiError, ConflictError } from '../http/errors.js';
import type { AdminEventsWriter } from './admin-events-writer.js';
import {
  parseReverseDnsModeInput,
  modeStringToTinyint,
  type ReverseDnsModeInput,
} from './reverse-dns.js';
import {
  FORCE_UPGRADE_REASONING_EFFORT,
  isLegacyModelUpgrade,
  normalizeReasoningEffortForModel,
  normalizeSupportedModel,
  REASONING_EFFORTS,
  SUPPORTED_MODELS,
} from './config-normalizer.js';

// ────────────────────────────────────────────────────────────────────────────
// Constants (mirrored from legacy PHP)
// ────────────────────────────────────────────────────────────────────────────

export const MIN_INSECURE_WINDOW_MINUTES = 0;
export const MAX_INSECURE_WINDOW_MINUTES = 480;
export const DEFAULT_INSECURE_WINDOW_MINUTES = 10;
export const PROVISIONING_WINDOW_MINUTES = 30;
export const QUICK_REGISTER_TTL_SECONDS = 7200;
export const INSTALL_TOKEN_TTL_SECONDS_DEFAULT = 1800;

// ────────────────────────────────────────────────────────────────────────────
// Engine parsing
// ────────────────────────────────────────────────────────────────────────────

export function parseEnginesInput(raw: unknown, fallback: Engine[]): Engine[] {
  if (raw === undefined || raw === null) return fallback.length ? fallback : [ENGINE_CODEX];
  const parts: string[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw) if (typeof r === 'string') parts.push(r);
  } else if (typeof raw === 'string') {
    for (const r of raw.split(',')) parts.push(r);
  } else {
    return fallback.length ? fallback : [ENGINE_CODEX];
  }
  const out: Engine[] = [];
  for (const p of parts) {
    const t = p.trim().toLowerCase();
    if (t === ENGINE_CODEX || t === ENGINE_CLAUDE) {
      if (!out.includes(t as Engine)) out.push(t as Engine);
    }
  }
  return out;
}

export function serializeEngines(engines: Engine[]): string {
  if (!engines.length) return ENGINE_CODEX;
  // canonical order: codex,claude
  const order: Engine[] = [];
  if (engines.includes(ENGINE_CODEX)) order.push(ENGINE_CODEX);
  if (engines.includes(ENGINE_CLAUDE)) order.push(ENGINE_CLAUDE);
  return order.join(',');
}

export function installerModeForEngines(engines: Engine[]): 'codex' | 'claude' | 'both' {
  const s = serializeEngines(engines);
  if (s === `${ENGINE_CODEX},${ENGINE_CLAUDE}`) return 'both';
  if (s === ENGINE_CLAUDE) return 'claude';
  return 'codex';
}

export function installerModeLabel(mode: 'codex' | 'claude' | 'both'): string {
  if (mode === 'claude') return 'Claude';
  if (mode === 'both') return 'Codex + Claude';
  return 'Codex';
}

export function installerCommand(url: string, curlInsecure: boolean): string {
  return curlInsecure
    ? `curl -k -fsSL ${url} | CODEX_INSTALL_CURL_INSECURE=1 sh`
    : `curl -fsSL ${url} | sh`;
}

// ────────────────────────────────────────────────────────────────────────────
// Semantic version validation (used by codex/claude version overrides)
// ────────────────────────────────────────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/;
export function isSemanticVersion(input: string): boolean {
  return SEMVER_RE.test(input.trim());
}

export function normalizeSemver(input: string): string {
  let v = input.trim();
  if (v.startsWith('v') || v.startsWith('V')) v = v.slice(1);
  return v;
}

// ────────────────────────────────────────────────────────────────────────────
// Insecure window helpers (clamp + grace)
// ────────────────────────────────────────────────────────────────────────────

export function clampInsecureMinutes(n: number | null | undefined, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback;
  if (v < MIN_INSECURE_WINDOW_MINUTES) return MIN_INSECURE_WINDOW_MINUTES;
  if (v > MAX_INSECURE_WINDOW_MINUTES) return MAX_INSECURE_WINDOW_MINUTES;
  return v;
}

export function computeGraceUntil(
  enabledUntil: Date | null,
  windowMinutes: number,
  graceMinutes: number,
): Date | null {
  if (!enabledUntil) return null;
  if (windowMinutes <= 0) return null;
  if (graceMinutes <= 0) return null;
  return new Date(enabledUntil.getTime() + graceMinutes * 60_000);
}

// ────────────────────────────────────────────────────────────────────────────
// Duplicate-key detection (register() TOCTOU on the `fqdn` unique index)
// ────────────────────────────────────────────────────────────────────────────

function isDuplicateFqdnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown; sqlMessage?: unknown };
  const isDupEntry = e.code === 'ER_DUP_ENTRY' || e.errno === 1062;
  if (!isDupEntry) return false;
  const msg = `${typeof e.sqlMessage === 'string' ? e.sqlMessage : ''} ${
    typeof e.message === 'string' ? e.message : ''
  }`.toLowerCase();
  return msg.includes('fqdn');
}

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

export interface HostManagementOptions {
  db: Database;
  env: Env;
  keyring: Keyring;
  events: AdminEventsWriter;
}

export interface InstallerInfo {
  token: string;
  mode: 'codex' | 'claude' | 'both';
  label: string;
  url: string;
  command: string;
  expires_at: string;
}

export interface RegisterRequest {
  fqdn: string;
  secure?: boolean;
  vip?: boolean;
  temporary?: boolean;
  curl_insecure?: boolean;
  reverse_dns_mode?: ReverseDnsModeInput | null;
  duration_minutes?: number | null;
  engines?: Engine[];
}

export interface QuickRegisterRequest {
  engines?: Engine[];
  duration_minutes?: number | null;
}

export interface MintInstallerOptions {
  curlInsecure?: boolean;
}

export class HostManagementService {
  constructor(private readonly opts: HostManagementOptions) {}

  get db(): Database {
    return this.opts.db;
  }
  get env(): Env {
    return this.opts.env;
  }
  get keyring(): Keyring {
    return this.opts.keyring;
  }
  get events(): AdminEventsWriter {
    return this.opts.events;
  }

  // ────────── Lookup ──────────

  async findById(id: number): Promise<Host | null> {
    const rows = await this.db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByFqdn(fqdn: string): Promise<Host | null> {
    const rows = await this.db.select().from(hosts).where(eq(hosts.fqdn, fqdn)).limit(1);
    return rows[0] ?? null;
  }

  async requireById(id: number): Promise<Host> {
    const host = await this.findById(id);
    if (!host) throw new NotFoundError('Host not found');
    return host;
  }

  // ────────── Logs ──────────

  async writeLog(hostId: number | null, action: string, details: Record<string, unknown>): Promise<void> {
    await this.db.insert(logs).values({
      hostId: hostId ?? null,
      action,
      details: Object.keys(details).length ? JSON.stringify(details) : null,
      createdAt: nowIso(),
    });
  }

  // ────────── Register / Quick register ──────────

  async register(
    req: RegisterRequest,
  ): Promise<{ host: Host; apiKeyPlain: string; installer: InstallerInfo }> {
    const fqdn = (req.fqdn ?? '').trim();
    if (!fqdn) throw new ValidationError('fqdn is required', { param: 'fqdn' });

    const existing = await this.findByFqdn(fqdn);

    // When re-registering/rotating an already-known host, an omitted
    // secure/engines field means "keep what's there", not "reset to the
    // global default" — otherwise every API-key rotation on an existing host
    // would silently downgrade its engines and flip it back to secure=1.
    const secure = req.secure ?? (existing ? existing.secure === 1 : true);
    const enginesIn =
      req.engines && req.engines.length
        ? req.engines
        : existing
          ? parseEnginesInput(existing.engines, [ENGINE_CODEX])
          : parseEnginesInput(this.env.DEFAULT_HOST_ENGINES, [ENGINE_CODEX]);
    const engines = enginesIn.length ? enginesIn : [ENGINE_CODEX];

    const apiKeyPlain = `sk-codex-${randomBytes(32).toString('hex')}`;
    const apiKeyHash = sha256(apiKeyPlain);
    const apiKeyEnc = sboxEncrypt(apiKeyPlain, this.keyring);
    const now = nowIso();

    let host: Host;

    if (existing) {
      await this.db
        .update(hosts)
        .set({
          apiKey: apiKeyHash,
          apiKeyHash,
          apiKeyEnc,
          secure: secure ? 1 : 0,
          engines: serializeEngines(engines),
          updatedAt: now,
        })
        .where(eq(hosts.id, existing.id));
      host = (await this.findById(existing.id))!;
      await this.writeLog(existing.id, 'register', {
        result: 'rotated',
        engines: serializeEngines(engines),
      });
    } else {
      try {
        await this.db.insert(hosts).values({
          fqdn,
          apiKey: apiKeyHash,
          apiKeyHash,
          apiKeyEnc,
          status: 'active',
          secure: secure ? 1 : 0,
          engines: serializeEngines(engines),
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        if (isDuplicateFqdnError(err)) {
          throw new ConflictError(`Host "${fqdn}" is already registered`, 'host_fqdn_conflict');
        }
        throw err;
      }
      host = (await this.findByFqdn(fqdn))!;
      await this.writeLog(host.id, 'register', {
        result: 'created',
        engines: serializeEngines(engines),
      });
    }

    // Open the initial insecure window for newly-provisioned insecure hosts.
    if (!secure) {
      const provisioningMinutes = clampInsecureMinutes(
        req.duration_minutes ?? PROVISIONING_WINDOW_MINUTES,
        PROVISIONING_WINDOW_MINUTES,
      );
      const storedMinutes = clampInsecureMinutes(
        req.duration_minutes ?? DEFAULT_INSECURE_WINDOW_MINUTES,
        DEFAULT_INSECURE_WINDOW_MINUTES,
      );
      const enabledUntil = new Date(Date.now() + provisioningMinutes * 60_000);
      const graceMinutes = clampInsecureMinutes(this.env.INSECURE_GRACE_MINUTES, 60);
      const grace = computeGraceUntil(enabledUntil, storedMinutes, graceMinutes);
      await this.db
        .update(hosts)
        .set({
          insecureEnabledUntil: enabledUntil,
          insecureGraceUntil: grace,
          insecureWindowMinutes: storedMinutes,
          updatedAt: nowIso(),
        })
        .where(eq(hosts.id, host.id));
      await this.writeLog(host.id, 'auth.insecure.initial_window', {
        enabled_until: enabledUntil.toISOString(),
        window_minutes: provisioningMinutes,
        stored_window_minutes: storedMinutes,
      });
      host = (await this.findById(host.id))!;
    }

    // Apply optional toggles (vip, temporary, curl_insecure, reverse_dns_mode)
    const patch: Partial<Host> = {};
    if (typeof req.vip === 'boolean') patch.vip = req.vip ? 1 : 0;
    if (typeof req.temporary === 'boolean') {
      patch.expiresAt = req.temporary ? isoOffsetSeconds(QUICK_REGISTER_TTL_SECONDS) : null;
    }
    if (typeof req.curl_insecure === 'boolean') patch.curlInsecure = req.curl_insecure ? 1 : 0;
    if (req.reverse_dns_mode) {
      const mode = parseReverseDnsModeInput(req.reverse_dns_mode);
      if (mode === null) {
        throw new ValidationError('reverse_dns_mode must be one of: global, enabled, disabled', {
          param: 'reverse_dns_mode',
        });
      }
      patch.reverseDnsMode = modeStringToTinyint(mode);
    }
    if (Object.keys(patch).length > 0) {
      await this.db
        .update(hosts)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(hosts.id, host.id));
      host = (await this.findById(host.id))!;
    }

    const installer = await this.issueInstallerToken(host, apiKeyPlain, engines);

    await this.events.appendAndPublish(
      existing ? 'host.updated' : 'host.created',
      {
        host_id: host.id,
        fqdn: host.fqdn,
        engines: host.engines,
        secure: host.secure === 1,
      },
      {
        hostId: host.id,
        wsType: existing ? 'host.updated' : 'host.created',
        wsPayload: { id: host.id, fqdn: host.fqdn },
      },
    );

    return { host, apiKeyPlain, installer };
  }

  async quickRegister(
    req: QuickRegisterRequest,
  ): Promise<{ host: Host; apiKeyPlain: string; installer: InstallerInfo }> {
    const engines =
      req.engines && req.engines.length
        ? req.engines
        : parseEnginesInput(this.env.DEFAULT_HOST_ENGINES, [ENGINE_CODEX]);
    if (!engines.length) {
      throw new ValidationError('engines must contain at least one of: codex, claude', { param: 'engines' });
    }
    const fqdn = await this.generateQuickHostName();
    const result = await this.register({
      fqdn,
      secure: false,
      vip: false,
      temporary: true,
      curl_insecure: false,
      duration_minutes: req.duration_minutes ?? null,
      engines,
    });
    await this.writeLog(result.host.id, 'admin.host.quick_register', {
      fqdn,
      engines: serializeEngines(engines),
      expires_at: result.host.expiresAt,
    });
    return result;
  }

  async mintInstaller(
    id: number,
    additionalEngines?: Engine[],
    options: MintInstallerOptions = {},
  ): Promise<{ host: Host; installer: InstallerInfo }> {
    let host = await this.requireById(id);
    const legacyPlainApiKey = host.apiKey && !/^[a-f0-9]{64}$/.test(host.apiKey) ? host.apiKey : null;
    const apiKeyPlain = decryptOrNull(host.apiKeyEnc ?? null, this.keyring) ?? legacyPlainApiKey;
    if (!apiKeyPlain) {
      throw new ApiError('Host API key is not recoverable; rotate the host before minting an installer', {
        status: 409,
        code: 'host_api_key_unavailable',
      });
    }
    const parsedEngines = parseEnginesInput(host.engines, [ENGINE_CODEX]);
    const currentEngines: Engine[] = parsedEngines.length ? parsedEngines : [ENGINE_CODEX];
    // Union with any caller-supplied engines (e.g. "add Claude" flow).
    const union: Engine[] = [...currentEngines];
    if (additionalEngines && additionalEngines.length) {
      for (const e of additionalEngines) {
        if (!union.includes(e)) union.push(e);
      }
    }
    const engines = union.length ? union : [ENGINE_CODEX];
    const enginesChanged = serializeEngines(engines) !== serializeEngines(currentEngines);
    const curlInsecureChanged =
      typeof options.curlInsecure === 'boolean' && (host.curlInsecure === 1) !== options.curlInsecure;

    if (enginesChanged || curlInsecureChanged) {
      const patch: Partial<Host> = { updatedAt: nowIso() };
      if (enginesChanged) patch.engines = serializeEngines(engines);
      if (curlInsecureChanged) patch.curlInsecure = options.curlInsecure ? 1 : 0;
      await this.db
        .update(hosts)
        .set(patch)
        .where(eq(hosts.id, host.id));
      host = (await this.findById(host.id))!;
      if (enginesChanged) {
        await this.writeLog(host.id, 'admin.host.engines_added', {
          fqdn: host.fqdn,
          previous: serializeEngines(currentEngines),
          engines: serializeEngines(engines),
        });
      }
      if (curlInsecureChanged) {
        await this.writeLog(host.id, 'admin.host.curl_insecure', {
          fqdn: host.fqdn,
          curl_insecure: options.curlInsecure,
          source: 'installer_mint',
        });
      }
    }

    const installer = await this.issueInstallerToken(host, apiKeyPlain, engines, additionalEngines);

    await this.events.appendAndPublish(
      'host.installer.minted',
      {
        host_id: host.id,
        fqdn: host.fqdn,
        engines: serializeEngines(engines),
        installer_mode: installer.mode,
        expires_at: installer.expires_at,
        engines_changed: enginesChanged,
        curl_insecure: host.curlInsecure === 1,
      },
      {
        hostId: host.id,
        wsType: 'host.updated',
        wsPayload: { id: host.id, fqdn: host.fqdn },
      },
    );

    return { host, installer };
  }

  private async generateQuickHostName(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const stamp = nowIso().replace(/[-:]/g, '').replace('T', '-').replace(/Z$/, '').slice(0, 15);
      const suffix = randomBytes(3).toString('hex');
      const candidate = `tmp-${stamp}-${suffix}`;
      if (!(await this.findByFqdn(candidate))) return candidate;
    }
    const stamp = nowIso().replace(/[-:]/g, '').replace('T', '-').replace(/Z$/, '').slice(0, 15);
    return `tmp-${stamp}-${randomBytes(6).toString('hex')}`;
  }

  // ────────── Installer tokens ──────────

  private async issueInstallerToken(
    host: Host,
    apiKeyPlain: string,
    engines: Engine[],
    requestedEngines?: Engine[],
  ): Promise<InstallerInfo> {
    const baseUrl = this.resolveInstallerBaseUrl();
    const ttl = INSTALL_TOKEN_TTL_SECONDS_DEFAULT;
    const expiresAt = isoOffsetSeconds(ttl);

    // Replace any existing pending install token for this host.
    await this.db.delete(installTokens).where(eq(installTokens.hostId, host.id));

    const token = randomUUID();
    // Schema column is CHAR(64), the legacy code stores sha256 of the token in
    // `token` and the encrypted real token in `token_enc`.
    const tokenHash = sha256(token);
    const tokenEnc = sboxEncrypt(token, this.keyring);
    const apiKeyHash = sha256(apiKeyPlain);
    const apiKeyEnc = sboxEncrypt(apiKeyPlain, this.keyring);
    const mode = installerModeForEngines(engines);
    // The installer SCRIPT targets a single engine. When the operator explicitly
    // asks to install ONE engine (the host-detail "Codex"/"Claude" buttons send
    // [codex] / [claude]), honour that choice; otherwise default to codex-when-
    // present. Without this, adding Claude to an existing codex host always
    // emitted a codex installer — there was no supported way to install the
    // second engine on a dual-engine host. `mode` still reflects the host's full
    // engine set (the union), so the displayed label is unchanged.
    const installerEngine: Engine =
      requestedEngines && requestedEngines.length === 1
        ? requestedEngines[0]!
        : engines.includes(ENGINE_CODEX)
          ? ENGINE_CODEX
          : ENGINE_CLAUDE;

    await this.db.insert(installTokens).values({
      token: tokenHash,
      tokenEnc,
      hostId: host.id,
      apiKey: apiKeyHash,
      apiKeyEnc,
      fqdn: host.fqdn,
      baseUrl,
      engine: installerEngine,
      expiresAt,
      createdAt: nowIso(),
    });

    await this.writeLog(host.id, 'admin.install_token.create', {
      fqdn: host.fqdn,
      expires_at: expiresAt,
      installer_mode: mode,
      token: `${token.slice(0, 8)}…`,
    });

    const url = `${baseUrl.replace(/\/+$/, '')}/install/${token}`;
    return {
      token,
      mode,
      label: installerModeLabel(mode),
      url,
      command: installerCommand(url, host.curlInsecure === 1),
      expires_at: expiresAt,
    };
  }

  private resolveInstallerBaseUrl(): string {
    const candidate = this.env.PUBLIC_BASE_URL ?? this.env.CODEX_SYNC_BASE_URL;
    if (!candidate || !candidate.trim()) {
      if (this.env.PUBLIC_BASE_URL_REQUIRED) {
        throw new ApiError('Unable to determine public base URL for installer. Set PUBLIC_BASE_URL.', {
          status: 500,
          code: 'server_misconfigured',
        });
      }
      return 'http://localhost';
    }
    return candidate.trim();
  }

  // ────────── Delete + clear ──────────

  async delete(id: number): Promise<{ host: Host }> {
    const host = await this.requireById(id);
    await this.writeLog(id, 'admin.host.delete', { fqdn: host.fqdn });
    // FK cascades take care of children where defined; explicit digest cleanup
    // matches the legacy controller for safety.
    await this.db.delete(hostAuthDigests).where(eq(hostAuthDigests.hostId, id));
    await this.db.delete(hosts).where(eq(hosts.id, id));
    await this.events.appendAndPublish(
      'host.deleted',
      { host_id: id, fqdn: host.fqdn },
      { hostId: null, wsType: 'host.deleted', wsPayload: { id, fqdn: host.fqdn } },
    );
    return { host };
  }

  async clear(id: number): Promise<{ host: Host }> {
    const host = await this.requireById(id);
    await this.db.delete(hostAuthDigests).where(eq(hostAuthDigests.hostId, id));
    await this.db
      .update(hosts)
      .set({
        lastRefresh: null,
        authDigest: null,
        claudeLastRefresh: null,
        claudeAuthDigest: null,
        updatedAt: nowIso(),
      })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.clear', { fqdn: host.fqdn });
    const fresh = (await this.findById(id))!;
    await this.events.appendAndPublish(
      'host.updated',
      { host_id: id, fqdn: host.fqdn, action: 'clear' },
      { hostId: id, wsType: 'host.updated', wsPayload: { id, fqdn: host.fqdn } },
    );
    return { host: fresh };
  }

  /**
   * Clear static IPv4/IPv6 bindings before a planned network move. The next
   * authenticated host request establishes a fresh binding under the existing
   * secure/roaming policy.
   */
  async releaseIpBinding(id: number): Promise<Host> {
    const host = await this.requireById(id);
    const previousIp4 = host.ip4 ?? null;
    const previousIp6 = host.ip6 ?? null;
    await this.db
      .update(hosts)
      .set({ ip4: null, ip6: null, updatedAt: nowIso() })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.ip_binding_released', {
      fqdn: host.fqdn,
      previous_ip4: previousIp4,
      previous_ip6: previousIp6,
    });
    return await this.publishUpdate(id, host.fqdn, {
      action: 'release_ip_binding',
      previous_ip4: previousIp4,
      previous_ip6: previousIp6,
    });
  }

  // ────────── Toggles ──────────

  async setRoaming(id: number, allow: boolean): Promise<Host> {
    const host = await this.requireById(id);
    await this.db
      .update(hosts)
      .set({ allowRoamingIps: allow ? 1 : 0, updatedAt: nowIso() })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.roaming', {
      fqdn: host.fqdn,
      allow_roaming: allow,
    });
    return await this.publishUpdate(id, host.fqdn, { allow_roaming_ips: allow });
  }

  async setSecure(id: number, secure: boolean, graceMinutes?: number | null): Promise<Host> {
    const host = await this.requireById(id);
    const patch: Partial<Host> = { secure: secure ? 1 : 0, updatedAt: nowIso() };
    if (secure) {
      // Re-securing clears any open insecure window. If the host had an
      // unexpired window, we set a grace until = now + graceMinutes (default
      // env INSECURE_GRACE_MINUTES) so trailing operations still finish.
      const hadOpenWindow =
        host.insecureEnabledUntil instanceof Date && host.insecureEnabledUntil.getTime() > Date.now();
      patch.insecureEnabledUntil = null;
      if (hadOpenWindow) {
        const gm = clampInsecureMinutes(graceMinutes ?? this.env.INSECURE_GRACE_MINUTES ?? 60, 60);
        patch.insecureGraceUntil = gm > 0 ? new Date(Date.now() + gm * 60_000) : null;
      } else {
        patch.insecureGraceUntil = null;
      }
    }
    await this.db.update(hosts).set(patch).where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.secure', { fqdn: host.fqdn, secure });
    return await this.publishUpdate(id, host.fqdn, { secure });
  }

  async setVip(id: number, vip: boolean): Promise<Host> {
    const host = await this.requireById(id);
    await this.db
      .update(hosts)
      .set({ vip: vip ? 1 : 0, updatedAt: nowIso() })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.vip', { fqdn: host.fqdn, vip });
    return await this.publishUpdate(id, host.fqdn, { vip });
  }

  async setScalingExempt(id: number, exempt: boolean): Promise<Host> {
    const host = await this.requireById(id);
    await this.db
      .update(hosts)
      .set({ scalingExempt: exempt ? 1 : 0, updatedAt: nowIso() })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.scaling_exempt', {
      fqdn: host.fqdn,
      scaling_exempt: exempt,
    });
    return await this.publishUpdate(id, host.fqdn, { scaling_exempt: exempt });
  }

  async setAutoUpdateOverride(id: number, override: boolean | null): Promise<Host> {
    const host = await this.requireById(id);
    const value = override === null ? null : override ? 1 : 0;
    await this.db
      .update(hosts)
      .set({ autoUpdateOverride: value, updatedAt: nowIso() })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.auto_update', { fqdn: host.fqdn, override });
    return await this.publishUpdate(id, host.fqdn, { auto_update_override: override });
  }

  async setCurlInsecure(id: number, allow: boolean): Promise<Host> {
    const host = await this.requireById(id);
    await this.db
      .update(hosts)
      .set({ curlInsecure: allow ? 1 : 0, updatedAt: nowIso() })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.curl_insecure', {
      fqdn: host.fqdn,
      curl_insecure: allow,
    });
    return await this.publishUpdate(id, host.fqdn, { curl_insecure: allow });
  }

  async setBrowserOsMcp(id: number, enabled: boolean): Promise<Host> {
    const host = await this.requireById(id);
    await this.db
      .update(hosts)
      .set({
        browserosMcpEnabled: enabled ? 1 : 0,
        configVersion: Number(host.configVersion ?? 0) + 1,
        updatedAt: nowIso(),
      })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.browseros_mcp', {
      fqdn: host.fqdn,
      browseros_mcp_enabled: enabled,
    });
    return await this.publishUpdate(id, host.fqdn, { browseros_mcp_enabled: enabled });
  }

  async setEngines(id: number, enginesIn: Engine[]): Promise<Host> {
    const host = await this.requireById(id);
    const engines = enginesIn.length ? enginesIn : [];
    if (!engines.length) {
      throw new ValidationError('engines must contain at least one of: codex, claude', { param: 'engines' });
    }
    const previous = serializeEngines(parseEnginesInput(host.engines, [ENGINE_CODEX]));
    const next = serializeEngines(engines);
    if (next !== previous) {
      await this.db
        .update(hosts)
        .set({ engines: next, updatedAt: nowIso() })
        .where(eq(hosts.id, id));
      await this.writeLog(id, 'admin.host.engines', {
        fqdn: host.fqdn,
        previous,
        engines: next,
      });
    }
    return await this.publishUpdate(id, host.fqdn, {
      previous_engines: previous,
      engines: next,
    });
  }

  async setReverseDnsMode(id: number, mode: ReverseDnsModeInput): Promise<Host> {
    const host = await this.requireById(id);
    const value = modeStringToTinyint(mode);
    await this.db.update(hosts).set({ reverseDnsMode: value, updatedAt: nowIso() }).where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.reverse_dns', {
      fqdn: host.fqdn,
      reverse_dns_mode: mode,
    });
    return await this.publishUpdate(id, host.fqdn, { reverse_dns_mode: mode });
  }

  // ────────── Overrides (model / codex / claude / agents) ──────────

  async setModelOverrides(
    id: number,
    payload: {
      model_override?: string | null | undefined;
      reasoning_effort_override?: string | null | undefined;
      claude_model_override?: string | null | undefined;
      includeClaudeOverride?: boolean;
    },
  ): Promise<Host> {
    const host = await this.requireById(id);
    const patch: Partial<Host> = { updatedAt: nowIso() };
    const rawModelOverride =
      payload.model_override === undefined ? undefined : payload.model_override?.trim() ?? '';
    const modelWasLegacy = isLegacyModelUpgrade(rawModelOverride);
    if (payload.model_override !== undefined) {
      if (rawModelOverride === '') {
        patch.modelOverride = null;
      } else {
        const normalizedModel = normalizeSupportedModel(rawModelOverride);
        if (normalizedModel === null) {
          throw new ValidationError(
            `model_override must be one of: ${SUPPORTED_MODELS.join(', ')}`,
            { param: 'model_override' },
          );
        }
        patch.modelOverride = normalizedModel;
      }
    }
    if (payload.reasoning_effort_override !== undefined) {
      const rawEffort = payload.reasoning_effort_override?.trim() ?? '';
      if (rawEffort === '') {
        patch.reasoningEffortOverride = null;
      } else {
        const effectiveModel = patch.modelOverride ?? host.modelOverride ?? null;
        const normalizedEffort = normalizeReasoningEffortForModel(rawEffort, effectiveModel);
        if (normalizedEffort === null) {
          throw new ValidationError(`reasoning_effort_override must be one of: ${REASONING_EFFORTS.join(', ')}`, {
            param: 'reasoning_effort_override',
          });
        }
        patch.reasoningEffortOverride = normalizedEffort;
      }
    } else if (modelWasLegacy && patch.modelOverride !== null) {
      patch.reasoningEffortOverride = FORCE_UPGRADE_REASONING_EFFORT;
    }
    if (payload.includeClaudeOverride) {
      patch.claudeModelOverride = payload.claude_model_override
        ? payload.claude_model_override.trim() || null
        : null;
    }
    await this.db.update(hosts).set(patch).where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.model_overrides', {
      fqdn: host.fqdn,
      model_override: patch.modelOverride ?? host.modelOverride ?? null,
      reasoning_effort_override: patch.reasoningEffortOverride ?? host.reasoningEffortOverride ?? null,
      ...(payload.includeClaudeOverride ? { claude_model_override: patch.claudeModelOverride ?? null } : {}),
    });
    return await this.publishUpdate(id, host.fqdn, { model_overrides_changed: true });
  }

  async setCodexVersionOverride(id: number, selection: string | null): Promise<Host> {
    const host = await this.requireById(id);
    let stored: string | null = null;
    if (selection !== null) {
      const normalized = normalizeSemver(selection);
      if (!isSemanticVersion(normalized)) {
        throw new ValidationError('selection must be a semantic version like 0.125.0', {
          param: 'selection',
        });
      }
      stored = normalized;
    }
    await this.db
      .update(hosts)
      .set({ clientVersionOverride: stored, updatedAt: nowIso() })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.client_version_override', {
      fqdn: host.fqdn,
      client_version_override: stored,
    });
    return await this.publishUpdate(id, host.fqdn, { client_version_override: stored });
  }

  async setClaudeVersionOverride(id: number, selection: string | null): Promise<Host> {
    const host = await this.requireById(id);
    let stored: string | null = null;
    if (selection !== null) {
      const normalized = normalizeSemver(selection);
      if (!isSemanticVersion(normalized)) {
        throw new ValidationError('selection must be a semantic version like 1.2.3', {
          param: 'selection',
        });
      }
      stored = normalized;
    }
    await this.db
      .update(hosts)
      .set({ claudeClientVersionOverride: stored, updatedAt: nowIso() })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.claude_client_version_override', {
      fqdn: host.fqdn,
      claude_client_version_override: stored,
    });
    return await this.publishUpdate(id, host.fqdn, {
      claude_client_version_override: stored,
    });
  }

  async setAgentsDocumentOverride(id: number, selection: string | number | null): Promise<Host> {
    const host = await this.requireById(id);
    let stored: number | null = null;
    if (selection !== null && selection !== '' && selection !== 'global') {
      const num = typeof selection === 'number' ? selection : Number.parseInt(String(selection), 10);
      if (!Number.isFinite(num) || num <= 0) {
        throw new ValidationError('selection must be a valid agents document id', {
          param: 'selection',
        });
      }
      stored = num;
    }
    await this.db
      .update(hosts)
      .set({ agentsDocumentIdOverride: stored, updatedAt: nowIso() })
      .where(eq(hosts.id, id));
    await this.writeLog(id, 'admin.host.agents_version_override', {
      fqdn: host.fqdn,
      agents_document_id_override: stored,
    });
    return await this.publishUpdate(id, host.fqdn, { agents_document_id_override: stored });
  }

  // ────────── Helper ──────────

  private async publishUpdate(id: number, fqdn: string, payload: Record<string, unknown>): Promise<Host> {
    const fresh = (await this.findById(id))!;
    await this.events.appendAndPublish(
      'host.updated',
      { host_id: id, fqdn, ...payload },
      { hostId: id, wsType: 'host.updated', wsPayload: { id, fqdn } },
    );
    return fresh;
  }
}
