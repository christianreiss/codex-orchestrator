/**
 * Runtime half of the external Communication Interface (docs/external-clients.md).
 *
 * An external client has no wrapper, so the server runs a *virtual native
 * session* on its behalf under the server-owned `external` host: a registered
 * session + address, a native-control row, and a presence attachment that exists
 * while the client's poll is open (plus a grace window). Delivery then uses the
 * ordinary owned-messaging claim/ack/reply services, unchanged.
 *
 * Everything here is deliberately thin: the messaging rules (FIFO, leases,
 * idempotency, task results) stay in `services/agent-messaging/owned-*`.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { externalClients, hosts, type ExternalClient, type Host } from '../../db/schema.js';
import type { Env } from '../../env.js';
import { ApiError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { ownerPresence } from '../../control-plane/presence.js';
import { pollOwnedControl, realignOwnedControl } from '../../control-plane/streams/native-control.js';
import { requireOwnerRuntime, type OwnerRuntime } from '../../control-plane/state/runtime.js';
import { registerOwnedMessagingSession } from '../../control-plane/state/session-registration.js';
import { claimOwnedDelivery } from '../agent-messaging/owned-claim.js';
import { acknowledgeOwnedDelivery } from '../agent-messaging/owned-delivery.js';
import { replyOwnedMessage } from '../agent-messaging/owned-reply.js';
import { sendOwnedMessage } from '../agent-messaging/owned-send.js';
import { discoverOwnedAddresses } from '../agent-messaging/owned-discovery.js';
import { writeExternalClients } from './write.js';
import { AGENT_MESSAGING_MAX_BODY_BYTES as MAX_MESSAGE_BYTES } from '../agent-messaging/constants.js';
import type { MessageDelivery } from '../agent-messaging/types.js';
import type { Engine } from '../../util/engine.js';
import { ENGINE_EXTERNAL } from '../../util/engine.js';
import { EXTERNAL_ROLE } from '../internal-hosts.js';
import { nowIso } from '../../util/timestamp.js';
import { bridgeTokenFor } from './keys.js';
import { oneLine } from './normalize.js';

export const POLL_MAX_WAIT_SECONDS = 25;
/** An open poll or heartbeat keeps the client "listening" for this long. */
export const PRESENCE_GRACE_MS = 90_000;
const TOUCH_INTERVAL_MS = 60_000;
/** How long a registered virtual session is reused before it is re-registered. */
const ENSURE_CACHE_MS = 30_000;
export const ADAPTER_PROTOCOL = 'external-rest-v1';

export class ExternalCallError extends ApiError {
  constructor(status: number, code: string, message: string, headers?: Record<string, string>) {
    super(message, { status, code, headers });
  }
}

interface Virtual {
  /** The client's stored row, read fresh by `ensure`: trust and description are never stale. */
  client: ExternalClient;
  runtime: OwnerRuntime;
  host: Host;
  sessionId: string;
  token: string;
  addressId: string;
  instanceId: string;
}

interface Presence {
  detach(): void;
  abort(): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ExternalBridge {
  private readonly presence = new Map<string, Presence>();
  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly keyring: Keyring,
  ) {}

  /** The server-owned host that carries every external session; created at boot. */
  private async externalHost(): Promise<Host> {
    const [host] = await this.db.select().from(hosts).where(eq(hosts.internalRole, EXTERNAL_ROLE)).limit(1);
    if (!host) throw new ServiceUnavailableError('External clients are not provisioned', 'external_host_missing');
    return host;
  }

  private readonly ensuring = new Map<string, Promise<unknown>>();
  private readonly touched = new Map<string, number>();
  private readonly cache = new Map<string, { at: number; value: Virtual }>();

  /**
   * Register (or refresh) the client's virtual session; stable address across
   * restarts. Serialised per client and re-reading the stored row, so concurrent
   * first calls (or a caller holding a stale row) never mint a second address.
   */
  async ensure(client: ExternalClient): Promise<Virtual> {
    const hit = this.cache.get(client.id);
    if (hit && Date.now() - hit.at < ENSURE_CACHE_MS) return hit.value;
    const previous = this.ensuring.get(client.id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.ensureLocked(client));
    const tail = run.catch(() => undefined);
    this.ensuring.set(client.id, tail);
    void tail.then(() => {
      if (this.ensuring.get(client.id) === tail) this.ensuring.delete(client.id);
    });
    return run.then((value) => {
      this.cache.set(client.id, { at: Date.now(), value });
      return value;
    });
  }

  /** Forget the cached session binding, e.g. after the client row changed. */
  forget(clientId: string): void {
    this.cache.delete(clientId);
  }

  private async ensureLocked(given: ExternalClient): Promise<Virtual> {
    const [stored] = await this.db.select().from(externalClients).where(eq(externalClients.id, given.id)).limit(1);
    const client = stored ?? given;
    const runtime = requireOwnerRuntime(this.db);
    const host = await this.externalHost();
    const token = bridgeTokenFor(client.id, client.bridgeSecret);
    const attempt = async (sessionId: string) =>
      registerOwnedMessagingSession(
        runtime,
        host,
        {
          engine: ENGINE_EXTERNAL as unknown as Engine,
          username: `external-${client.id.slice(0, 8)}`,
          cwd: `/external/${client.id}`,
          invocationKind: 'interactive',
          sessionId,
          bridgeToken: token,
          requestedAddress: client.addressId ? `agent:${client.addressId}` : null,
          continuity: 'reset',
          adapterProtocol: ADAPTER_PROTOCOL,
          adapterCapabilities: { execution_contract_version: 2 },
        },
        this.env,
      );
    let sessionId = client.sessionId ?? randomUUID();
    let result: Record<string, unknown>;
    try {
      result = await attempt(sessionId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'agent_session_finished' && code !== 'agent_session_conflict') throw error;
      sessionId = randomUUID();
      result = await attempt(sessionId);
    }
    if (result.enabled === false)
      throw new ExternalCallError(503, 'messaging_disabled', 'Agent messaging is disabled on this server');
    const address = result.address as { id: string };
    if (client.sessionId !== sessionId || client.addressId !== address.id) {
      await writeExternalClients(this.db, 'external_client.bind_session', { id: client.id }, (tx) =>
        tx
          .update(externalClients)
          .set({ sessionId, addressId: address.id, updatedAt: nowIso() })
          .where(eq(externalClients.id, client.id)),
      );
    }
    const snapshot = runtime.state.snapshot();
    const instanceId = snapshot.table('agentNativeControls').get(sessionId)?.instanceId ?? randomUUID();
    // The control row only serves native stop, but the delivery claim requires it to match the session's
    // current binding. A re-registration can leave it stale (native_stop_binding_changed on every call,
    // agent_messaging_lease_lost on claim), so realign it: an external client has no process to stop.
    try {
      await pollOwnedControl(runtime, sessionId, instanceId);
    } catch (error) {
      if ((error as { code?: string }).code !== 'native_stop_binding_changed') throw error;
      await realignOwnedControl(runtime, sessionId, instanceId);
    }
    return { client, runtime, host, sessionId, token, addressId: address.id, instanceId };
  }

  /** Attach presence for this client; a newer attachment replaces (and aborts) the older poll. */
  private attach(client: ExternalClient, v: Virtual): { signal: AbortSignal; release(): void } {
    const previous = this.presence.get(client.id);
    if (previous) {
      previous.abort();
      previous.detach();
      if (previous.timer) clearTimeout(previous.timer);
    }
    const session = v.runtime.state.snapshot().sessions.get(v.sessionId)!;
    const handle = ownerPresence(v.runtime).attach({
      connectionId: `external:${client.id}:${randomUUID()}`,
      hostId: v.host.id,
      username: session.username,
      scope: {
        topic: 'session',
        session_id: v.sessionId,
        binding_generation: session.bindingGeneration,
        native_instance_id: v.instanceId,
      },
    });
    const controller = new AbortController();
    const entry: Presence = { detach: () => handle.detach(), abort: () => controller.abort() };
    this.presence.set(client.id, entry);
    return {
      signal: controller.signal,
      release: () => {
        if (this.presence.get(client.id) !== entry) return;
        entry.timer = setTimeout(() => {
          if (this.presence.get(client.id) === entry) this.presence.delete(client.id);
          entry.detach();
        }, PRESENCE_GRACE_MS);
        entry.timer.unref?.();
      },
    };
  }

  /** Keep presence alive between polls without opening one. */
  async heartbeat(client: ExternalClient): Promise<void> {
    const v = await this.ensure(client);
    const held = this.attach(client, v);
    held.release();
    await this.touch(client);
  }

  private async touch(client: ExternalClient): Promise<void> {
    // Each write is an owner command; one a minute is plenty for "last seen".
    const last = this.touched.get(client.id) ?? 0;
    if (Date.now() - last < TOUCH_INTERVAL_MS) return;
    this.touched.set(client.id, Date.now());
    await writeExternalClients(this.db, 'external_client.touch', { id: client.id }, (tx) =>
      tx.update(externalClients).set({ lastPollAt: nowIso() }).where(eq(externalClients.id, client.id)),
    );
  }

  /**
   * One poll. Returns at most one message (the mailbox is strictly FIFO with one
   * unacknowledged message in flight); an unacknowledged message is returned
   * again on every poll until acknowledged.
   */
  async poll(client: ExternalClient, waitSeconds: number): Promise<MessageDelivery | null> {
    const v = await this.ensure(client);
    const { signal, release } = this.attach(client, v);
    await this.touch(client);
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), POLL_MAX_WAIT_SECONDS) * 1000;
    try {
      for (;;) {
        const delivery = await this.claimOnce(v);
        if (delivery) return delivery;
        const left = deadline - Date.now();
        if (left <= 0 || signal.aborted) return null;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            unsubscribe();
            signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, Math.min(left, 1000));
          const unsubscribe = v.runtime.state.subscribe(done);
          signal.addEventListener('abort', done, { once: true });
        });
        if (signal.aborted) return null;
      }
    } finally {
      release();
    }
  }

  private async claimOnce(v: Virtual): Promise<MessageDelivery | null> {
    const snapshot = v.runtime.state.snapshot();
    const owner = `session:${v.sessionId}`;
    const open = snapshot.messages
      .by('targetAddressId', v.addressId)
      .find((row) => row.status === 'leased' && row.leaseOwner === owner && row.claimId);
    return claimOwnedDelivery(this.db, v.runtime, this.keyring, {
      targetAddressIds: [v.addressId],
      leaseOwner: owner,
      claimId: open?.claimId ?? randomUUID(),
      relayGeneration: null,
      skipReceiveCapable: false,
      informationalOnly: false,
      deliveryTimingEnabled: true,
      smartQueue: false,
      peerBatch: false,
    });
  }

  /** Acknowledge by message id; idempotent and tolerant of stale claims. */
  async ack(client: ExternalClient, messageIds: string[]): Promise<{ acked: string[]; unknown: string[] }> {
    const v = await this.ensure(client);
    const acked: string[] = [];
    const unknown: string[] = [];
    for (const id of messageIds) {
      const row = v.runtime.state.snapshot().messages.get(id);
      if (!row || row.targetAddressId !== v.addressId) {
        unknown.push(id);
        continue;
      }
      if (row.status !== 'leased' || row.leaseOwner !== `session:${v.sessionId}` || !row.claimId) {
        acked.push(id); // already acknowledged, finished or redelivered elsewhere
        continue;
      }
      await acknowledgeOwnedDelivery(
        this.db,
        v.runtime,
        this.keyring,
        id,
        { claimId: row.claimId, outcome: row.workKind ? 'accepted' : 'completed' },
        `session:${v.sessionId}`,
        null,
        v.sessionId,
      );
      acked.push(id);
    }
    return { acked, unknown };
  }

  async send(
    client: ExternalClient,
    body: {
      clientMessageId: string;
      to: string;
      content: string;
      conversationId?: string | null;
      deliveryClass?: string;
      relatedWorkId?: string | null;
      ttlSeconds?: number | null;
    },
  ): Promise<Record<string, unknown>> {
    this.assertSize(body.content);
    const v = await this.ensure(client);
    return sendOwnedMessage(this.db, v.runtime, this.keyring, v.sessionId, v.token, {
      to: body.to,
      content: stampExternalContent(v.client, body.content),
      clientMessageId: body.clientMessageId,
      conversationId: body.conversationId ?? null,
      ttlSeconds: body.ttlSeconds ?? null,
      queue: {
        delivery_class: (body.deliveryClass as 'information') ?? 'information',
        delivery_timing: 'after_turn',
        ...(body.relatedWorkId ? { related_work_id: body.relatedWorkId } : {}),
      },
    });
  }

  async reply(
    client: ExternalClient,
    body: { clientMessageId: string; replyTo: string; content: string; ttlSeconds?: number | null },
  ): Promise<Record<string, unknown>> {
    this.assertSize(body.content);
    const v = await this.ensure(client);
    return replyOwnedMessage(
      this.db,
      v.runtime,
      this.keyring,
      { kind: 'session', id: v.sessionId, token: v.token },
      body.replyTo,
      { content: stampExternalContent(v.client, body.content), clientMessageId: body.clientMessageId, ttlSeconds: body.ttlSeconds ?? null },
    );
  }

  /** Report a work outcome for a message the client accepted. */
  async result(
    client: ExternalClient,
    body: { workId: string; status: 'succeeded' | 'failed' | 'blocked' | 'unknown'; summary: string },
  ): Promise<Record<string, unknown>> {
    const v = await this.ensure(client);
    const row = v.runtime.state.snapshot().messages.get(body.workId);
    if (!row || row.targetAddressId !== v.addressId || !row.workKind)
      throw new NotFoundError('Work message not found', 'message_not_found');
    if (!row.claimId) throw new ConflictError('Work was never delivered', 'work_not_delivered');
    return acknowledgeOwnedDelivery(
      this.db,
      v.runtime,
      this.keyring,
      body.workId,
      {
        claimId: row.claimId,
        outcome: 'completed',
        taskResult: { status: body.status, summary: oneLine(body.summary || body.status, 4096) || body.status },
      },
      `session:${v.sessionId}`,
      null,
      v.sessionId,
    );
  }

  /**
   * Peer discovery, projected to what an external client may know: who exists,
   * whether they are reachable, and their role. No hosts, paths or task titles.
   */
  async agents(
    client: ExternalClient,
    filters: { name?: string; engine?: string; includeOffline?: boolean; limit?: number; offset?: number },
  ): Promise<Record<string, unknown>> {
    const v = await this.ensure(client);
    const found = (await discoverOwnedAddresses(this.db, v.runtime, v.sessionId, v.token, {
      scope: 'fleet',
      name: filters.name,
      engine: filters.engine as Engine | undefined,
      includeOffline: filters.includeOffline,
      limit: filters.limit,
      offset: filters.offset,
    })) as Record<string, unknown>;
    const rows = (found.addresses as Array<Record<string, unknown>>) ?? [];
    return {
      agents: rows.map((row) => ({
        address: row.address,
        name: row.name ?? null,
        alias: row.alias ?? null,
        engine: row.engine,
        presence: row.presence,
        role: row.role ?? null,
      })),
      total: found.total ?? rows.length,
      next_offset: found.next_offset ?? null,
      server_time: nowIso(),
    };
  }

  /** Server-side end of the client's presence (disable/rotate/delete). */
  drop(clientId: string): void {
    this.cache.delete(clientId);
    const entry = this.presence.get(clientId);
    if (!entry) return;
    this.presence.delete(clientId);
    entry.abort();
    entry.detach();
    if (entry.timer) clearTimeout(entry.timer);
  }

  private assertSize(content: string): void {
    if (Buffer.byteLength(String(content ?? ''), 'utf8') > EXTERNAL_CONTENT_MAX_BYTES)
      throw new ExternalCallError(413, 'content_too_large', `content exceeds ${EXTERNAL_CONTENT_MAX_BYTES} UTF-8 bytes`);
  }
}

/**
 * Room kept for the server-stamped header (below) inside the bus's own message
 * limit. A header is at most ~420 bytes (96 name + 160 description + framing).
 */
export const EXTERNAL_CONTENT_MAX_BYTES = MAX_MESSAGE_BYTES - 512;

export const EXTERNAL_HEADER_PREFIX = '[from external client ';

/**
 * Native receivers (cdx/clx/cgx) see only the message text, so the client's
 * identity and trust level travel as a server-written first line. It is part of
 * the stored message and cannot be set or removed by the sender; a body that
 * imitates one is still preceded by the real header.
 */
export function externalHeader(client: Pick<ExternalClient, 'name' | 'description' | 'trust'>): string {
  const about = client.description ? ` (${client.description})` : '';
  return `${EXTERNAL_HEADER_PREFIX}"${client.name}"${about} · trust: ${client.trust} · written by the server, not by the sender]`;
}

export function stampExternalContent(client: ExternalClient, content: string): string {
  return `${externalHeader(client)}\n\n${content}`;
}

/** Remove our own header again for an external receiver, who gets `sender.trust` as a field. */
export function stripExternalHeader(content: string): string {
  if (!content.startsWith(EXTERNAL_HEADER_PREFIX)) return content;
  const end = content.indexOf(']\n\n');
  return end === -1 ? content : content.slice(end + 3);
}

export { ForbiddenError, ValidationError };
