/**
 * External clients: admin lifecycle, key authentication and the wire envelope
 * (docs/external-clients.md). The messaging itself lives in `bridge.ts`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { externalClients, type ExternalClient } from '../../db/schema.js';
import type { Env } from '../../env.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { safeHashEqual } from '../agent-messaging/internals.js';
import type { MessageDelivery } from '../agent-messaging/types.js';
import { nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import { ENGINE_EXTERNAL } from '../../util/engine.js';
import { ExternalBridge, ExternalCallError, ADAPTER_PROTOCOL, stripExternalHeader } from './bridge.js';
import { EXTERNAL_KEY_PREFIX, hashExternalKey, newExternalKey } from './keys.js';
import {
  isExternalTrust,
  normalizeExternalDescription,
  normalizeExternalName,
  normalizeExternalTrust,
  type ExternalTrust,
} from './normalize.js';

export { ExternalCallError, ADAPTER_PROTOCOL };

export interface ExternalClientView {
  id: string;
  name: string;
  description: string;
  trust: ExternalTrust;
  enabled: boolean;
  key_prefix: string;
  address: string | null;
  last_poll_at: string | null;
  created_at: string;
  updated_at: string;
}

export function externalClientView(row: ExternalClient): ExternalClientView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    trust: isExternalTrust(row.trust) ? row.trust : 'untrusted',
    enabled: row.enabled === 1,
    key_prefix: row.keyPrefix,
    address: row.addressId ? `agent:${row.addressId}` : null,
    last_poll_at: row.lastPollAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export interface CreateExternalClientInput {
  name: unknown;
  description?: unknown;
  trust?: unknown;
  enabled?: unknown;
  adminId?: number | null;
}

export class ExternalClientsService {
  readonly bridge: ExternalBridge;
  constructor(
    private readonly db: Database,
    env: Env,
    keyring: Keyring,
  ) {
    this.bridge = new ExternalBridge(db, env, keyring);
  }

  async list(): Promise<ExternalClientView[]> {
    const rows = await this.db.select().from(externalClients);
    return rows.sort((a, b) => a.name.localeCompare(b.name)).map(externalClientView);
  }

  private async row(id: string): Promise<ExternalClient> {
    const [row] = await this.db.select().from(externalClients).where(eq(externalClients.id, id)).limit(1);
    if (!row) throw new NotFoundError('External client not found', 'external_client_not_found');
    return row;
  }

  async get(id: string): Promise<ExternalClientView> {
    return externalClientView(await this.row(id));
  }

  /** Create a client. The key is returned once and never stored in the clear. */
  async create(input: CreateExternalClientInput): Promise<{ client: ExternalClientView; key: string }> {
    const { name, key: nameKey } = normalizeExternalName(input.name);
    const key = newExternalKey();
    const now = nowIso();
    const id = randomUUID();
    try {
      await this.db.insert(externalClients).values({
        id,
        name,
        nameKey,
        description: normalizeExternalDescription(input.description),
        trust: normalizeExternalTrust(input.trust),
        enabled: input.enabled === false ? 0 : 1,
        keyHash: key.hash,
        keyPrefix: key.prefix,
        bridgeSecret: randomBytes(32).toString('hex'),
        createdByAdminId: input.adminId ?? null,
        createdAt: now,
        updatedAt: now,
        disabledAt: input.enabled === false ? now : null,
      });
    } catch (error) {
      if (isDuplicate(error))
        throw new ConflictError('An external client with this name already exists', 'external_client_name_taken');
      throw error;
    }
    wsPublisher.publish('external_client.changed', { id });
    return { client: await this.get(id), key: key.key };
  }

  async update(
    id: string,
    patch: { name?: unknown; description?: unknown; trust?: unknown; enabled?: unknown },
  ): Promise<ExternalClientView> {
    const current = await this.row(id);
    const set: Partial<ExternalClient> = { updatedAt: nowIso() };
    if (patch.name !== undefined) {
      const { name, key } = normalizeExternalName(patch.name);
      set.name = name;
      set.nameKey = key;
    }
    if (patch.description !== undefined) set.description = normalizeExternalDescription(patch.description);
    if (patch.trust !== undefined) set.trust = normalizeExternalTrust(patch.trust);
    if (patch.enabled !== undefined) {
      set.enabled = patch.enabled ? 1 : 0;
      set.disabledAt = patch.enabled ? null : nowIso();
    }
    try {
      await this.db.update(externalClients).set(set).where(eq(externalClients.id, id));
    } catch (error) {
      if (isDuplicate(error))
        throw new ConflictError('An external client with this name already exists', 'external_client_name_taken');
      throw error;
    }
    if (patch.enabled === false) this.bridge.drop(current.id);
    wsPublisher.publish('external_client.changed', { id });
    return this.get(id);
  }

  /** Replace the key; the old one stops working at once. */
  async rotateKey(id: string): Promise<{ client: ExternalClientView; key: string }> {
    await this.row(id);
    const key = newExternalKey();
    await this.db
      .update(externalClients)
      .set({ keyHash: key.hash, keyPrefix: key.prefix, updatedAt: nowIso() })
      .where(eq(externalClients.id, id));
    this.bridge.drop(id);
    wsPublisher.publish('external_client.changed', { id });
    return { client: await this.get(id), key: key.key };
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    this.bridge.drop(id);
    await this.db.delete(externalClients).where(eq(externalClients.id, id));
    wsPublisher.publish('external_client.changed', { id });
  }

  /**
   * Resolve a bearer key. Distinguishes an unknown key from a disabled client so
   * the adapter can tell a terminal failure from a typo.
   */
  async authenticate(bearer: string | null): Promise<ExternalClient> {
    if (!bearer || !bearer.startsWith(EXTERNAL_KEY_PREFIX))
      throw new ExternalCallError(401, 'key_invalid', 'Unknown client key');
    const hash = hashExternalKey(bearer);
    const [row] = await this.db.select().from(externalClients).where(eq(externalClients.keyHash, hash)).limit(1);
    if (!row || !safeHashEqual(row.keyHash, hash))
      throw new ExternalCallError(401, 'key_invalid', 'Unknown client key');
    if (row.enabled !== 1) throw new ExternalCallError(403, 'client_disabled', 'This client is disabled');
    return row;
  }

  /** The wire envelope of one delivery (docs/external-clients.md → Envelope). */
  async envelope(delivery: MessageDelivery): Promise<Record<string, unknown>> {
    const sender = delivery.sender as { id?: string; address?: string; name?: string | null; alias?: string | null; engine?: string };
    let name = sender.name ?? sender.alias ?? null;
    let description = '';
    let trust: ExternalTrust = 'peer';
    if (sender.engine === ENGINE_EXTERNAL && sender.id) {
      const [row] = await this.db.select().from(externalClients).where(eq(externalClients.addressId, sender.id)).limit(1);
      if (row) {
        name = row.name;
        description = row.description;
        trust = isExternalTrust(row.trust) ? row.trust : 'untrusted';
      } else {
        trust = 'untrusted';
      }
    }
    const work = Boolean(delivery.work_kind) || ['request', 'task'].includes(delivery.kind);
    const kind = delivery.kind === 'reply' ? 'reply' : delivery.kind === 'publication' ? 'publication' : 'message';
    return {
      message_id: delivery.message_id,
      attempt: delivery.attempts,
      conversation_id: delivery.conversation_id,
      sequence: delivery.sequence,
      kind,
      reply_to: delivery.reply_to_message_id,
      work_id: work ? delivery.message_id : (delivery.related_work_id ?? null),
      expects_reply: work || delivery.delivery_class === 'coordination',
      delivery_class: delivery.delivery_class ?? 'information',
      created_at: (delivery as { created_at?: string }).created_at ?? null,
      expires_at: delivery.expires_at,
      server_time: nowIso(),
      sender: {
        address: sender.address ?? null,
        name: oneLineOrNull(name),
        engine: sender.engine ?? null,
        description,
        trust,
      },
      content: sender.engine === ENGINE_EXTERNAL ? stripExternalHeader(delivery.content) : delivery.content,
    };
  }
}

/** Drizzle wraps the driver error; the duplicate-key code sits on the cause chain. */
function isDuplicate(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++)
    if ((e as { code?: string }).code === 'ER_DUP_ENTRY') return true;
  return false;
}

function oneLineOrNull(value: string | null | undefined): string | null {
  const text = String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 96) : null;
}
