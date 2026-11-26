/**
 * Real provider API keys (OpenAI, Anthropic, xAI, Moonshot) for the gateway
 * surfaces' upstream source. Server-side only: never leased to hosts, never on
 * `/auth`, never reachable through the MCP secrets store.
 *
 * The key exists only as an `sbox:v1` envelope in owner-private core content
 * (`keyEnc`). `key_hash` dedupes per provider and is never returned; the admin
 * API shows `key_hint`. Nothing here puts the key, its envelope or its hash
 * into an error, a log line, an audit payload or an owner command payload.
 *
 * Writes run through owner commands (`mutateOwnerState`) with an admin audit
 * row each. Reads also have a direct-SQL path for databases without a bound
 * owner (fixture tests).
 */
import {
  mutateOwnerState,
  ownerRuntimeFor,
  requireOwnerRuntime,
  withOwnerBackgroundScope,
} from '../control-plane/state/runtime.js';
import { stageDelete, stageUpdate } from '../control-plane/state/rows.js';
import { adminAudit } from '../control-plane/state/admin.js';
import type { Json } from '../control-plane/commands.js';
import type { Database } from '../db/client.js';
import { providerApiKeys, type ProviderApiKey } from '../db/schema.js';
import { ApiError, ConflictError, NotFoundError } from '../http/errors.js';
import type { Keyring } from '../security/keyring.js';
import { decryptOrNull, encrypt as encryptSecret } from '../security/secret-box.js';
import { sha256 } from '../security/hash.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { InvalidBaseUrlError, parseBaseUrl, type UpstreamNetworkPolicy } from './gateway-upstream/base-url.js';
import { PROVIDERS, PROVIDER_IDS, isProviderId, type ProviderId } from './gateway-upstream/providers.js';
import { pendingProviderKeyTelemetry } from './gateway-upstream/telemetry.js';
import type { VerificationResult } from './gateway-upstream/verify.js';

export type ProviderKeyState = 'active' | 'paused';
export type ProviderKeyVerificationState = 'unverified' | 'valid' | 'invalid' | 'error';
export const PROVIDER_KEY_STATES: readonly ProviderKeyState[] = ['active', 'paused'];

/** Everything about a key except its value, envelope and hash. */
export type ProviderKeyMeta = Omit<ProviderApiKey, 'keyEnc' | 'keyHash'>;

/** A decrypted forward candidate. Lives only for the request that asked for it. */
export interface ProviderKeyCandidate {
  id: number;
  sortOrder: number;
  provider: ProviderId;
  baseUrl: string;
  key: string;
  keyHash: string;
}

const LABEL_MAX = 255;
const KEY_MIN = 16;
const KEY_MAX = 1024;
/** This orchestrator's own gateway keys (`openai-keys.ts` layout). */
const GATEWAY_KEY_SHAPE = /^sk-(?:cdx|ant|cgx|ckx)-[0-9a-f]{64}$/;

function invalid(message: string, param?: string, code = 'invalid_request'): ApiError {
  return new ApiError(message, { status: 400, code, type: 'invalid_request_error', param });
}

function meta<T extends { keyHash?: unknown; keyEnc?: unknown }>(row: T): ProviderKeyMeta {
  const { keyHash: _hash, keyEnc: _enc, ...rest } = row as T & Record<string, unknown>;
  return rest as unknown as ProviderKeyMeta;
}

function byOrder(a: ProviderKeyMeta, b: ProviderKeyMeta): number {
  return (
    PROVIDER_IDS.indexOf(a.provider as ProviderId) - PROVIDER_IDS.indexOf(b.provider as ProviderId) ||
    a.sortOrder - b.sortOrder ||
    a.id - b.id
  );
}

export function parseProvider(value: unknown): ProviderId {
  if (!isProviderId(value)) throw invalid(`provider must be one of ${PROVIDER_IDS.join(', ')}`, 'provider');
  return value;
}

function parseLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label) throw invalid('label is required', 'label');
  if (label.length > LABEL_MAX) throw invalid(`label must be at most ${LABEL_MAX} characters`, 'label');
  return label;
}

/** Shape-only checks; the message never contains the submitted value. */
function parseKeyValue(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw invalid('key is required', 'key');
  if (key.length < KEY_MIN || key.length > KEY_MAX) throw invalid(`key must be ${KEY_MIN}-${KEY_MAX} characters`, 'key');
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(key)) throw invalid('key must not contain whitespace or control characters', 'key');
  if (GATEWAY_KEY_SHAPE.test(key))
    throw invalid('This is a gateway key issued by this orchestrator, not a provider API key', 'key', 'gateway_key_not_allowed');
  return key;
}

/** `sk-proj-…a1b2`: the key's type prefix and its last four characters. */
export function keyHint(key: string): string {
  const head = key.slice(0, 12);
  const dash = head.lastIndexOf('-');
  return `${dash > 0 ? head.slice(0, dash + 1) : ''}…${key.slice(-4)}`;
}

export interface CreateProviderKeyInput {
  provider: unknown;
  label: unknown;
  key: unknown;
  base_url?: unknown;
  adminUserId?: number | null;
}

export interface UpdateProviderKeyInput {
  label?: unknown;
  key?: unknown;
  base_url?: unknown;
}

export interface ProviderApiKeyServiceDeps {
  db: Database;
  keyring: Keyring;
  policy: UpstreamNetworkPolicy;
}

export class ProviderApiKeyService {
  constructor(private readonly deps: ProviderApiKeyServiceDeps) {}

  private parseBaseUrlField(value: unknown): string | null {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
    try {
      return parseBaseUrl(value, this.deps.policy);
    } catch (err) {
      if (err instanceof InvalidBaseUrlError) throw invalid(err.message, 'base_url', 'invalid_base_url');
      throw err;
    }
  }

  /** Every key, in provider order then failover order, with pending telemetry folded in. */
  async list(): Promise<ProviderKeyMeta[]> {
    const owner = ownerRuntimeFor(this.deps.db);
    if (owner) {
      owner.assertOwner();
      return owner.state
        .snapshot()
        .table('providerApiKeys')
        .all()
        .map((row) => {
          const pending = pendingProviderKeyTelemetry(owner, row.id);
          const view = meta(row);
          if (!pending) return view;
          return {
            ...view,
            lastUsedAt: pending.usedAt && (!view.lastUsedAt || pending.usedAt > view.lastUsedAt) ? pending.usedAt : view.lastUsedAt,
            ...(pending.errorAt && (!view.lastErrorAt || pending.errorAt >= view.lastErrorAt)
              ? { lastErrorAt: pending.errorAt, lastErrorStatus: pending.errorStatus ?? null, lastErrorReason: pending.errorReason ?? null }
              : {}),
          };
        })
        .sort(byOrder);
    }
    const rows = await this.deps.db.select().from(providerApiKeys);
    return rows.map(meta).sort(byOrder);
  }

  async get(id: number): Promise<ProviderKeyMeta | null> {
    return (await this.list()).find((row) => row.id === id) ?? null;
  }

  /** Keys the forward may use: `active` and not `invalid`, decrypted, with the effective base URL. */
  async candidates(provider: ProviderId): Promise<ProviderKeyCandidate[]> {
    const rows = await this.secretRows((row) => row.provider === provider && row.state === 'active' && row.verificationState !== 'invalid');
    return rows
      .flatMap(({ row, key }) =>
        key === null
          ? []
          : [{ id: row.id, sortOrder: row.sortOrder, provider, baseUrl: row.baseUrl ?? PROVIDERS[provider].defaultBaseUrl, key, keyHash: row.keyHash }],
      )
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }

  /** One decrypted key for an admin verification, or null when it does not exist. */
  async secret(id: number): Promise<ProviderKeyCandidate | null> {
    const [found] = await this.secretRows((row) => row.id === id);
    if (!found || found.key === null || !isProviderId(found.row.provider)) return null;
    const provider = found.row.provider;
    return {
      id,
      sortOrder: found.row.sortOrder,
      provider,
      baseUrl: found.row.baseUrl ?? PROVIDERS[provider].defaultBaseUrl,
      key: found.key,
      keyHash: found.row.keyHash,
    };
  }

  private async secretRows(
    match: (row: Omit<ProviderApiKey, 'keyEnc'>) => boolean,
  ): Promise<Array<{ row: Omit<ProviderApiKey, 'keyEnc'>; key: string | null }>> {
    const owner = ownerRuntimeFor(this.deps.db);
    if (owner) {
      owner.assertOwner();
      const state = owner.state.snapshot();
      return state
        .table('providerApiKeys')
        .all()
        .filter(match)
        .map((row) => {
          const envelope = state.content('providerApiKeys', row.id, 'keyEnc');
          return { row, key: typeof envelope === 'string' ? decryptOrNull(envelope, this.deps.keyring) : null };
        });
    }
    const rows = await this.deps.db.select().from(providerApiKeys);
    return rows.filter(match).map(({ keyEnc, ...row }) => ({ row, key: decryptOrNull(keyEnc, this.deps.keyring) }));
  }

  async create(input: CreateProviderKeyInput): Promise<ProviderKeyMeta> {
    const provider = parseProvider(input.provider);
    const label = parseLabel(input.label);
    const key = parseKeyValue(input.key);
    const baseUrl = this.parseBaseUrlField(input.base_url);
    const keyHash = sha256(key);
    const keyEnc = encryptSecret(key, this.deps.keyring);
    const hint = keyHint(key);
    const owner = requireOwnerRuntime(this.deps.db);
    let saved: ProviderKeyMeta | undefined;
    await mutateOwnerState(owner, {
      kind: 'provider_key.create',
      payload: { provider, label, base_url: baseUrl },
      prepare: (ctx) => {
        // Our own gateway keys are refused as upstream keys, by shape (above) or by hash.
        if (ctx.snapshot.table('openaiApiKeys').by('keyHash', keyHash).length > 0)
          throw invalid('This is a gateway key issued by this orchestrator, not a provider API key', 'key', 'gateway_key_not_allowed');
        const table = ctx.snapshot.table('providerApiKeys');
        if (table.by('keyHash', keyHash).some((row) => row.provider === provider))
          throw new ConflictError('This key is already stored for this provider', 'provider_key_duplicate');
        const siblings = table.all().filter((row) => row.provider === provider);
        const sortOrder = siblings.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
        const now = nowIso();
        const row = {
          provider,
          label,
          keyEnc,
          keyHash,
          keyHint: hint,
          baseUrl,
          sortOrder,
          state: 'active',
          verificationState: 'unverified',
          verificationCheckedAt: null,
          verificationReason: null,
          lastUsedAt: null,
          lastErrorAt: null,
          lastErrorStatus: null,
          lastErrorReason: null,
          createdByAdminUserId: input.adminUserId ?? null,
          createdAt: now,
          updatedAt: now,
        };
        ctx.write(async (tx) => {
          const [inserted] = await tx.insert(providerApiKeys).values(row);
          const next = { id: Number(inserted.insertId), ...row };
          ctx.draft.upsert('providerApiKeys', next);
          saved = meta(next);
        });
        adminAudit(ctx, 'provider_key.created', () => ({ key_id: saved?.id ?? null, provider, label }));
        return () => saved as unknown as Json;
      },
    });
    this.changed(saved!.id, provider, 'created');
    return saved!;
  }

  async update(id: number, input: UpdateProviderKeyInput): Promise<ProviderKeyMeta> {
    const patch: Partial<ProviderApiKey> = {};
    const fields: string[] = [];
    if (input.label !== undefined) {
      patch.label = parseLabel(input.label);
      fields.push('label');
    }
    if (input.base_url !== undefined) {
      patch.baseUrl = this.parseBaseUrlField(input.base_url);
      fields.push('base_url');
    }
    let keyHash: string | undefined;
    if (input.key !== undefined) {
      const key = parseKeyValue(input.key);
      keyHash = sha256(key);
      patch.keyHash = keyHash;
      patch.keyEnc = encryptSecret(key, this.deps.keyring);
      patch.keyHint = keyHint(key);
      fields.push('key');
    }
    if (!fields.length) throw invalid('Nothing to update: send label, base_url or key');
    const owner = requireOwnerRuntime(this.deps.db);
    let saved: ProviderKeyMeta | undefined;
    let provider: ProviderId | undefined;
    await mutateOwnerState(owner, {
      kind: 'provider_key.update',
      payload: { id, fields },
      prepare: (ctx) => {
        const current = ctx.snapshot.table('providerApiKeys').get(id);
        if (!current) throw new NotFoundError('Provider key not found', 'provider_key_not_found');
        provider = current.provider as ProviderId;
        if (keyHash !== undefined && keyHash !== current.keyHash) {
          if (ctx.snapshot.table('openaiApiKeys').by('keyHash', keyHash).length > 0)
            throw invalid('This is a gateway key issued by this orchestrator, not a provider API key', 'key', 'gateway_key_not_allowed');
          if (ctx.snapshot.table('providerApiKeys').by('keyHash', keyHash).some((row) => row.provider === current.provider && row.id !== id))
            throw new ConflictError('This key is already stored for this provider', 'provider_key_duplicate');
        }
        const credentialChanged =
          (keyHash !== undefined && keyHash !== current.keyHash) ||
          (patch.baseUrl !== undefined && patch.baseUrl !== current.baseUrl);
        const next = stageUpdate(ctx, 'providerApiKeys', id, {
          ...patch,
          ...(credentialChanged ? { verificationState: 'unverified', verificationCheckedAt: null, verificationReason: null } : {}),
          updatedAt: nowIso(),
        });
        saved = meta(next);
        adminAudit(ctx, 'provider_key.updated', { key_id: id, provider: current.provider, fields });
        return saved as unknown as Json;
      },
    });
    this.changed(id, provider!, 'updated');
    return saved!;
  }

  async setState(id: number, value: unknown): Promise<ProviderKeyMeta> {
    if (value !== 'active' && value !== 'paused') throw invalid('state must be active or paused', 'state');
    const owner = requireOwnerRuntime(this.deps.db);
    let saved: ProviderKeyMeta | undefined;
    let provider: ProviderId | undefined;
    await mutateOwnerState(owner, {
      kind: 'provider_key.state',
      payload: { id, state: value },
      prepare: (ctx) => {
        const current = ctx.snapshot.table('providerApiKeys').get(id);
        if (!current) throw new NotFoundError('Provider key not found', 'provider_key_not_found');
        provider = current.provider as ProviderId;
        saved = meta(current.state === value ? current : stageUpdate(ctx, 'providerApiKeys', id, { state: value, updatedAt: nowIso() }));
        if (current.state !== value) adminAudit(ctx, 'provider_key.state', { key_id: id, provider: current.provider, state: value });
        return saved as unknown as Json;
      },
    });
    this.changed(id, provider!, 'state');
    return saved!;
  }

  /** Set the failover order of one provider's keys; `ids` must be exactly that provider's keys. */
  async reorder(providerValue: unknown, idsValue: unknown): Promise<ProviderKeyMeta[]> {
    const provider = parseProvider(providerValue);
    if (!Array.isArray(idsValue) || !idsValue.every((id) => Number.isSafeInteger(id) && id > 0))
      throw invalid('ids must be an array of key ids', 'ids');
    const ids = idsValue as number[];
    if (new Set(ids).size !== ids.length) throw invalid('ids must not repeat', 'ids');
    const owner = requireOwnerRuntime(this.deps.db);
    await mutateOwnerState(owner, {
      kind: 'provider_key.reorder',
      payload: { provider, ids },
      prepare: (ctx) => {
        const current = ctx.snapshot
          .table('providerApiKeys')
          .all()
          .filter((row) => row.provider === provider);
        const known = new Set(current.map((row) => row.id));
        if (current.length !== ids.length || !ids.every((id) => known.has(id)))
          throw new ConflictError('ids must list every key of this provider exactly once', 'provider_key_order_mismatch');
        const now = nowIso();
        ids.forEach((id, index) => {
          const row = current.find((candidate) => candidate.id === id)!;
          if (row.sortOrder !== index) stageUpdate(ctx, 'providerApiKeys', id, { sortOrder: index, updatedAt: now });
        });
        adminAudit(ctx, 'provider_key.reordered', { provider, ids });
        return null;
      },
    });
    this.changed(null, provider, 'reordered');
    return (await this.list()).filter((row) => row.provider === provider);
  }

  async delete(id: number): Promise<boolean> {
    const owner = requireOwnerRuntime(this.deps.db);
    let provider: ProviderId | undefined;
    const deleted = (await mutateOwnerState(owner, {
      kind: 'provider_key.delete',
      payload: { id },
      prepare: (ctx) => {
        const current = ctx.snapshot.table('providerApiKeys').get(id);
        if (!current) return false;
        provider = current.provider as ProviderId;
        stageDelete(ctx, 'providerApiKeys', id);
        adminAudit(ctx, 'provider_key.deleted', { key_id: id, provider: current.provider, label: current.label });
        return true;
      },
    })) as boolean;
    if (deleted) this.changed(id, provider!, 'deleted');
    return deleted;
  }

  /**
   * Store a verification outcome, but only if the key and base URL it checked
   * are still the stored ones (a rotation in between makes it stale).
   * `background` marks the request-path re-check after a 401: it runs under
   * the background scope, only ever flips a key to `invalid`, and audits that
   * as `provider_key.invalidated`.
   */
  async recordVerification(
    checked: Pick<ProviderKeyCandidate, 'id' | 'keyHash' | 'baseUrl'>,
    result: VerificationResult,
    options: { background?: boolean } = {},
  ): Promise<ProviderKeyMeta | null> {
    const owner = requireOwnerRuntime(this.deps.db);
    const background = options.background === true;
    if (background && result.state !== 'invalid') return null;
    let saved: ProviderKeyMeta | null = null;
    let provider: ProviderId | undefined;
    const run = () =>
      mutateOwnerState(owner, {
        kind: background ? 'provider_key.invalidate' : 'provider_key.verify',
        ...(background ? { principal: 'system:provider-key-verify' } : {}),
        payload: { id: checked.id, state: result.state, reason: result.reason, status: result.status },
        prepare: (ctx) => {
          const current = ctx.snapshot.table('providerApiKeys').get(checked.id);
          if (!current || current.keyHash !== checked.keyHash) return null;
          if ((current.baseUrl ?? PROVIDERS[current.provider as ProviderId]?.defaultBaseUrl) !== checked.baseUrl) return null;
          provider = current.provider as ProviderId;
          if (background && current.verificationState === 'invalid') return null;
          const next = stageUpdate(ctx, 'providerApiKeys', checked.id, {
            verificationState: result.state,
            verificationCheckedAt: nowIso(),
            verificationReason: result.reason,
            updatedAt: nowIso(),
          });
          saved = meta(next);
          adminAudit(ctx, background ? 'provider_key.invalidated' : 'provider_key.verified', {
            key_id: checked.id,
            provider: current.provider,
            verification_state: result.state,
            reason: result.reason,
          });
          return saved as unknown as Json;
        },
      });
    await (background ? withOwnerBackgroundScope(run) : run());
    if (saved && provider) this.changed(checked.id, provider, background ? 'invalidated' : 'verified');
    return saved;
  }

  /** Per provider: stored keys, `active` keys and usable (active, not invalid) keys. */
  async counts(): Promise<Record<ProviderId, { total: number; active: number; usable: number }>> {
    const out = Object.fromEntries(PROVIDER_IDS.map((id) => [id, { total: 0, active: 0, usable: 0 }])) as Record<
      ProviderId,
      { total: number; active: number; usable: number }
    >;
    for (const row of await this.list()) {
      const bucket = out[row.provider as ProviderId];
      if (!bucket) continue;
      bucket.total += 1;
      if (row.state === 'active') {
        bucket.active += 1;
        if (row.verificationState !== 'invalid') bucket.usable += 1;
      }
    }
    return out;
  }

  private changed(id: number | null, provider: ProviderId, action: string): void {
    wsPublisher.publish('provider_key.changed', { id, provider, action });
  }
}
