import { randomUUID, createHash } from 'node:crypto';
import { and, eq, inArray, asc, sql } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import {
  versions,
  hosts,
  hostDaemons,
  hostDaemonSessions as sessions,
  hostDaemonOperations as operations,
  adminEvents,
  agentPrompts,
  agentBusAddresses,
  agentBusMessages,
} from '../../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import { encrypt, decrypt } from '../../security/secret-box.js';
import { activeHostEngines, assertHostEngineEnabled } from '../host-engine-policy.js';
import { readFleetEngineState } from '../engine-switch.js';
import { insecureWindowActive } from '../insecure-window.js';
import { wsPublisher } from '../../ws/publisher.js';
import { daemonSettingsSchema, daemonHealth, type DaemonRuntime, type DaemonSettings } from './policy.js';
import { ENGINE_HOST_FIELDS, type Engine } from '../../util/engine.js';

const now = () => new Date().toISOString();
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class HostDaemonService {
  constructor(private ctx: RouteContext) {}
  private get db() {
    return this.ctx.db;
  }
  async host(id: number) {
    const [host] = await this.db.select().from(hosts).where(eq(hosts.id, id));
    if (!host) throw new NotFoundError('Host not found');
    return host;
  }
  async settings(id: number) {
    const [row] = await this.db.select().from(hostDaemons).where(eq(hostDaemons.hostId, id));
    return (
      row ?? {
        hostId: id,
        settings: daemonSettingsSchema.parse({}),
        runtime: null,
        enabledAt: null,
        updatedAt: now(),
      }
    );
  }
  async view(id: number) {
    const [host, row, work] = await Promise.all([
      this.host(id),
      this.settings(id),
      this.db.select().from(sessions).where(eq(sessions.hostId, id)),
    ]);
    const engines = activeHostEngines(host.engines, await readFleetEngineState(this.db));
    const runtime = row.runtime
      ? {
          ...row.runtime,
          engines: row.runtime.engines.filter(
            (e) =>
              engines.includes(e as Engine) &&
              (!host.secure || Boolean(host[ENGINE_HOST_FIELDS[e as Engine].authDigest])),
          ),
        }
      : null;
    const health = daemonHealth(
      row.settings,
      runtime,
      row.enabledAt,
      work.filter((s) => ['running', 'stopping'].includes(s.status)).length,
      engines,
    );
    if (
      row.settings.enabled &&
      (host.status !== 'active' ||
        !host.agentMessagingEnabled ||
        (!host.secure && !insecureWindowActive(host)))
    ) {
      health.state = 'red';
      health.reasons.unshift('host_access_blocked');
    }
    const flags = await this.db
      .select()
      .from(versions)
      .where(inArray(versions.name, ['api_disabled', 'agent_messaging_enabled']));
    if (
      row.settings.enabled &&
      (flags.some((f) => f.name === 'api_disabled' && f.version === '1') ||
        !flags.some((f) => f.name === 'agent_messaging_enabled' && f.version === '1'))
    ) {
      health.state = 'red';
      health.reasons.unshift('messaging_or_api_disabled');
    }
    return { host_id: id, fqdn: host.fqdn, ...row.settings, health, sessions: work };
  }
  async configure(id: number, settings: DaemonSettings) {
    await this.host(id);
    await this.db.transaction(async (tx) => {
      await tx.select().from(hosts).where(eq(hosts.id, id)).for('update');
      const [old] = await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, id)).for('update');
      const active = await tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.hostId, id), inArray(sessions.status, ['running', 'stopping', 'queued'])));
      if (active.length && old?.settings.username !== settings.username)
        throw new ConflictError('Stop sessions before changing the service user');
      const values = {
        settings,
        updatedAt: now(),
        enabledAt: settings.enabled ? (old?.settings.enabled ? old.enabledAt : now()) : null,
      };
      await tx
        .insert(hostDaemons)
        .values({ hostId: id, ...values })
        .onDuplicateKeyUpdate({ set: values });
      if (!settings.enabled) {
        await tx
          .update(operations)
          .set({ status: 'canceled', updatedAt: now() })
          .where(and(eq(operations.hostId, id), inArray(operations.status, ['queued', 'offered'])));
        await tx
          .update(sessions)
          .set({ status: 'closed', lastActivityAt: now() })
          .where(and(eq(sessions.hostId, id), inArray(sessions.status, ['idle', 'waiting', 'queued'])));
      }
    });
    this.changed(id);
    return this.view(id);
  }
  async eligible(id: number, engine?: Engine, drain = false) {
    const host = await this.host(id),
      config = await this.settings(id);
    const flags = await this.db
      .select()
      .from(versions)
      .where(inArray(versions.name, ['api_disabled', 'agent_messaging_enabled']));
    if (
      flags.some((f) => f.name === 'api_disabled' && f.version === '1') ||
      !flags.some((f) => f.name === 'agent_messaging_enabled' && f.version === '1')
    )
      throw new ForbiddenError('Agent messaging or API disabled');
    if (
      (!config.settings.enabled && !drain) ||
      host.status !== 'active' ||
      !host.agentMessagingEnabled ||
      (!host.secure && !insecureWindowActive(host))
    )
      throw new ForbiddenError('Host daemon is not available', 'daemon_disabled');
    if (engine) assertHostEngineEnabled(host, engine, await readFleetEngineState(this.db));
    return config;
  }
  async connect(id: number, input: Omit<DaemonRuntime, 'generation' | 'heartbeat_at' | 'connected'>) {
    await this.eligible(id, undefined, true);
    return this.db.transaction(async (tx) => {
      const [config] = await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, id)).for('update');
      if (!config || input.username !== config.settings.username)
        throw new ForbiddenError('Daemon service user does not match enabled host settings');
      if (
        config.runtime?.connected &&
        config.runtime.instance_id !== input.instance_id &&
        Date.now() - Date.parse(config.runtime.heartbeat_at) < 90_000
      )
        throw new ConflictError('Another daemon instance is connected');
      const runtime: DaemonRuntime = {
        ...input,
        generation: randomUUID(),
        heartbeat_at: now(),
        connected: true,
      };
      await tx.update(hostDaemons).set({ runtime, updatedAt: now() }).where(eq(hostDaemons.hostId, id));
      this.changed(id);
      return { generation: runtime.generation, settings: config.settings };
    });
  }
  async heartbeat(id: number, generation: string, engines: string[], error: string | null) {
    const row = await this.settings(id);
    if (row.runtime?.generation !== generation) throw new ConflictError('Daemon generation changed');
    await this.db
      .update(hostDaemons)
      .set({ runtime: { ...row.runtime, engines, error, connected: true, heartbeat_at: now() } })
      .where(
        and(
          eq(hostDaemons.hostId, id),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${hostDaemons.runtime}, '$.generation')) = ${generation}`,
        ),
      );
    await this.sweep(id);
    const work = await this.db.select().from(sessions).where(eq(sessions.hostId, id));
    this.changed(id);
    return { settings: row.settings, stop: work.filter((s) => s.status === 'stopping').map((s) => s.id) };
  }
  async disconnect(id: number, generation: string) {
    const row = await this.settings(id);
    if (row.runtime?.generation === generation) {
      await this.db
        .update(hostDaemons)
        .set({ runtime: { ...row.runtime, connected: false } })
        .where(
          and(
            eq(hostDaemons.hostId, id),
            sql`JSON_UNQUOTE(JSON_EXTRACT(${hostDaemons.runtime}, '$.generation')) = ${generation}`,
          ),
        );
      this.changed(id);
    }
  }
  async start(
    input: {
      host_id: number;
      engine: Engine;
      cwd?: string;
      title: string;
      prompt: string;
      client_message_id: string;
    },
    owner: string,
  ) {
    const config = await this.eligible(input.host_id, input.engine);
    const cwd = input.cwd || config.settings.default_cwd;
    if (!cwd.startsWith('/') || cwd.includes('\0'))
      throw new ValidationError('An existing absolute working directory is required');
    const clientKey = `${owner}:${input.client_message_id}`,
      requestHash = hash(input);
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(hostDaemons)
        .where(eq(hostDaemons.hostId, input.host_id))
        .for('update');
      if (!locked?.settings.enabled) throw new ForbiddenError('Host daemon disabled');
      const [existing] = await tx.select().from(operations).where(eq(operations.clientKey, clientKey));
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ConflictError('Idempotency key reused with different input');
        return { operation_id: existing.id, session_id: existing.sessionId };
      }
      const id = randomUUID(),
        opId = randomUUID();
      await tx.insert(sessions).values({
        id,
        hostId: input.host_id,
        owner,
        engine: input.engine,
        username: locked.settings.username,
        cwd,
        title: input.title,
        status: 'queued',
        lastActivityAt: now(),
        createdAt: now(),
      });
      await tx.insert(operations).values({
        id: opId,
        sessionId: id,
        hostId: input.host_id,
        clientKey,
        requestHash,
        promptEnc: encrypt(input.prompt, this.ctx.keyring),
        status: 'queued',
        createdAt: now(),
        updatedAt: now(),
      });
      await tx.insert(adminEvents).values({
        type: 'host.daemon.start_requested',
        hostId: input.host_id,
        payload: { owner, session_id: id, operation_id: opId, engine: input.engine },
        createdAt: now(),
      });
      this.changed(input.host_id);
      return { operation_id: opId, session_id: id };
    });
  }
  async session(id: string, owner?: string) {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new NotFoundError('Remote session not found');
    if (owner && row.owner !== owner)
      throw new ForbiddenError('Only the creating agent may control this helper');
    const ops = await this.db
      .select()
      .from(operations)
      .where(eq(operations.sessionId, id))
      .orderBy(asc(operations.createdAt));
    return {
      ...row,
      address: row.addressId ? `agent:${row.addressId}` : null,
      operations: ops.map(({ promptEnc: _prompt, resultEnc, ...op }) => ({
        ...op,
        result: resultEnc ? (JSON.parse(decrypt(resultEnc, this.ctx.keyring)) as unknown) : null,
      })),
    };
  }
  async turn(id: string, prompt: string, clientId: string, owner?: string) {
    const row = await this.session(id, owner);
    await this.eligible(row.hostId, row.engine as Engine);
    const key = `${owner ?? 'admin'}:${clientId}`;
    return this.db.transaction(async (tx) => {
      const [config] = await tx
        .select()
        .from(hostDaemons)
        .where(eq(hostDaemons.hostId, row.hostId))
        .for('update');
      if (!config?.settings.enabled) throw new ForbiddenError('Host daemon disabled');
      const [locked] = await tx.select().from(sessions).where(eq(sessions.id, id)).for('update');
      const [prior] = await tx.select().from(operations).where(eq(operations.clientKey, key));
      if (prior) {
        if (prior.requestHash !== hash({ id, prompt })) throw new ConflictError('Idempotency key reused');
        return { operation_id: prior.id, session_id: id };
      }
      if (!locked || ['running', 'stopping', 'queued'].includes(locked.status))
        throw new ConflictError('Session is busy');
      if (!locked.addressId) throw new ConflictError('No native transcript to resume');
      const [address] = await tx
        .select()
        .from(agentBusAddresses)
        .where(eq(agentBusAddresses.id, locked.addressId));
      if (!address?.lastUpstreamSessionId) throw new ConflictError('Native transcript missing');
      const opId = randomUUID();
      await tx.insert(operations).values({
        id: opId,
        sessionId: id,
        hostId: locked.hostId,
        clientKey: key,
        requestHash: hash({ id, prompt }),
        promptEnc: encrypt(prompt, this.ctx.keyring),
        status: 'queued',
        createdAt: now(),
        updatedAt: now(),
      });
      await tx.update(sessions).set({ status: 'queued', lastActivityAt: now() }).where(eq(sessions.id, id));
      await tx.insert(adminEvents).values({
        type: 'host.daemon.start_requested',
        hostId: row.hostId,
        payload: { owner: owner ?? 'operator', session_id: id, operation_id: opId, kind: 'resume' },
        createdAt: now(),
      });
      this.changed(row.hostId);
      return { operation_id: opId, session_id: id };
    });
  }
  async stop(
    id: string,
    owner?: string,
    expected?: { status: string; lastActivityAt: string },
    actor = owner ?? 'operator',
  ) {
    const row = await this.session(id, owner);
    await this.db.transaction(async (tx) => {
      await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, row.hostId)).for('update');
      const [current] = await tx.select().from(sessions).where(eq(sessions.id, id)).for('update');
      if (!current || current.status === 'closed') return;
      if (
        expected &&
        (current.status !== expected.status || current.lastActivityAt !== expected.lastActivityAt)
      )
        return;
      await tx
        .update(operations)
        .set({ status: 'canceled', updatedAt: now() })
        .where(and(eq(operations.sessionId, id), inArray(operations.status, ['queued', 'offered'])));
      await tx
        .update(sessions)
        .set({ status: ['running', 'stopping'].includes(current.status) ? 'stopping' : 'closed' })
        .where(eq(sessions.id, id));
      await tx.insert(adminEvents).values({
        type: 'host.daemon.stop_requested',
        hostId: row.hostId,
        payload: { session_id: id, actor },
        createdAt: now(),
      });
    });
    this.changed(row.hostId);
    return this.session(id, owner);
  }
  async offer(id: number, generation: string) {
    const config = await this.eligible(id);
    const host = await this.host(id),
      fleet = await readFleetEngineState(this.db);
    if (config.runtime?.generation !== generation) throw new ConflictError('Daemon generation changed');
    return this.db.transaction(async (tx) => {
      await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, id)).for('update');
      const work = await tx.select().from(sessions).where(eq(sessions.hostId, id));
      const [op] = await tx
        .select()
        .from(operations)
        .where(and(eq(operations.hostId, id), inArray(operations.status, ['offered', 'queued'])))
        .orderBy(asc(operations.createdAt))
        .limit(1)
        .for('update');
      if (!op) return null;
      const session = work.find((s) => s.id === op.sessionId)!;
      if (Date.now() - Date.parse(op.createdAt) >= 600_000) {
        await tx
          .update(operations)
          .set({ status: 'expired', updatedAt: now() })
          .where(eq(operations.id, op.id));
        await tx.update(sessions).set({ status: 'failed' }).where(eq(sessions.id, session.id));
        return null;
      }
      if (
        work.filter((s) => ['running', 'stopping'].includes(s.status)).length >= config.settings.max_parallel
      )
        return null;
      assertHostEngineEnabled(host, session.engine as Engine, fleet);
      if (!config.runtime?.engines.includes(session.engine)) return null;
      const claimId = op.claimId ?? randomUUID();
      await tx
        .update(operations)
        .set({ status: 'offered', claimId, updatedAt: now() })
        .where(eq(operations.id, op.id));
      const [address] = session.addressId
        ? await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, session.addressId))
        : [];
      return {
        operation_id: op.id,
        claim_id: claimId,
        session_id: session.id,
        engine: session.engine,
        cwd: session.cwd,
        title: session.title,
        prompt: decrypt(op.promptEnc, this.ctx.keyring),
        address: address ? `agent:${address.id}` : '',
        binding_generation: address?.bindingGeneration ?? 0,
        upstream_session_id: address?.lastUpstreamSessionId ?? '',
      };
    });
  }
  async accept(hostId: number, id: string, claim: string) {
    await this.eligible(hostId);
    const host = await this.host(hostId),
      fleet = await readFleetEngineState(this.db);
    return this.db.transaction(async (tx) => {
      const [config] = await tx
        .select()
        .from(hostDaemons)
        .where(eq(hostDaemons.hostId, hostId))
        .for('update');
      const [op] = await tx.select().from(operations).where(eq(operations.id, id)).for('update');
      if (!op || op.hostId !== hostId || op.claimId !== claim)
        throw new ForbiddenError('Invalid operation claim');
      if (op.status === 'accepted') return { accepted: true };
      if (op.status !== 'offered') throw new ConflictError('Operation is no longer offered');
      const [target] = await tx.select().from(sessions).where(eq(sessions.id, op.sessionId));
      if (!target || target.status !== 'queued') throw new ConflictError('Session is no longer queued');
      assertHostEngineEnabled(host, target.engine as Engine, fleet);
      const running = await tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.hostId, hostId), inArray(sessions.status, ['running', 'stopping'])));
      if (!config?.settings.enabled || running.length >= config.settings.max_parallel)
        throw new ConflictError('No work slot available');
      await tx.update(operations).set({ status: 'accepted', updatedAt: now() }).where(eq(operations.id, id));
      await tx
        .update(sessions)
        .set({ status: 'running', lastActivityAt: now() })
        .where(eq(sessions.id, op.sessionId));
      return { accepted: true };
    });
  }
  async bind(hostId: number, operationId: string, claim: string, sessionId: string, addressId: string) {
    const [op] = await this.db.select().from(operations).where(eq(operations.id, operationId));
    if (!op || op.hostId !== hostId || op.claimId !== claim || op.status !== 'accepted')
      throw new ForbiddenError('Invalid daemon launch binding');
    await this.db.update(sessions).set({ sessionId, addressId }).where(eq(sessions.id, op.sessionId));
  }
  async bindPeer(hostId: number, sessionId: string, addressId: string) {
    const [remote] = await this.db
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.hostId, hostId), eq(sessions.addressId, addressId), eq(sessions.status, 'running')),
      );
    if (!remote) return false;
    await this.db.update(sessions).set({ sessionId }).where(eq(sessions.id, remote.id));
    return true;
  }
  async complete(
    hostId: number,
    id: string,
    claim: string,
    result: {
      status: 'completed' | 'failed' | 'unknown' | 'stopped';
      reply: string;
      upstream_session_id?: string;
    },
  ) {
    const encoded = encrypt(JSON.stringify(result), this.ctx.keyring);
    await this.db.transaction(async (tx) => {
      const [op] = await tx.select().from(operations).where(eq(operations.id, id)).for('update');
      if (!op || op.hostId !== hostId || op.claimId !== claim)
        throw new ForbiddenError('Invalid operation claim');
      if (op.resultEnc) {
        if (decrypt(op.resultEnc, this.ctx.keyring) !== JSON.stringify(result))
          throw new ConflictError('Result already stored');
        return;
      }
      if (['canceled', 'expired'].includes(op.status) && result.status === 'unknown') return;
      if (op.status === 'offered' && result.status !== 'unknown')
        throw new ConflictError('Operation was not accepted');
      if (!['accepted', 'offered'].includes(op.status))
        throw new ConflictError('Operation is no longer active');
      const [session] = await tx.select().from(sessions).where(eq(sessions.id, op.sessionId)).for('update');
      const [config] = await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, hostId));
      await tx
        .update(operations)
        .set({ status: result.status, resultEnc: encoded, updatedAt: now() })
        .where(eq(operations.id, id));
      const prompts = session?.sessionId
        ? await tx
            .select()
            .from(agentPrompts)
            .where(and(eq(agentPrompts.sessionId, session.sessionId), eq(agentPrompts.status, 'open')))
            .limit(1)
        : [];
      const status =
        session?.status === 'stopping' || result.status === 'stopped' || !config?.settings.enabled
          ? 'closed'
          : result.status === 'completed'
            ? prompts.length
              ? 'waiting'
              : 'idle'
            : result.status;
      await tx.update(sessions).set({ status, lastActivityAt: now() }).where(eq(sessions.id, op.sessionId));
    });
    this.changed(hostId);
    return { stored: true };
  }
  async peerFinished(hostId: number, id: string, messageId: string) {
    await this.db.transaction(async (tx) => {
      await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, hostId)).for('update');
      const [session] = await tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.hostId, hostId)))
        .for('update');
      const [message] = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId));
      if (!session || !message || message.targetAddressId !== session.addressId)
        throw new ForbiddenError('Remote delivery mismatch');
      if (session.activeMessageId !== messageId) return { stored: true };
      if (['leased', 'accepted'].includes(message.status)) throw new ConflictError('Delivery still active');
      const [config] = await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, hostId));
      await tx
        .update(sessions)
        .set({
          status:
            session.status === 'stopping' || !config?.settings.enabled
              ? 'closed'
              : message.status === 'ambiguous'
                ? 'unknown'
                : 'idle',
          activeMessageId: null,
          lastActivityAt: now(),
        })
        .where(and(eq(sessions.id, id), eq(sessions.activeMessageId, messageId)));
    });
    this.changed(hostId);
    return { stored: true };
  }
  async sweep(hostId: number) {
    const config = await this.settings(hostId);
    const work = await this.db.select().from(sessions).where(eq(sessions.hostId, hostId));
    for (const session of work) {
      if (
        ['closed', 'failed', 'unknown'].includes(session.status) &&
        Date.now() - Date.parse(session.lastActivityAt) >
          this.ctx.env.AGENT_PORTAL_RETENTION_HOURS * 3_600_000
      ) {
        await this.db
          .update(operations)
          .set({ promptEnc: '', resultEnc: null, claimId: null, status: 'retired' })
          .where(
            and(
              eq(operations.sessionId, session.id),
              inArray(operations.status, [
                'completed',
                'failed',
                'unknown',
                'stopped',
                'canceled',
                'expired',
              ]),
            ),
          );
      }

      if (session.status === 'queued') {
        await this.db.transaction(async (tx) => {
          await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, hostId)).for('update');
          const pending = await tx
            .select()
            .from(operations)
            .where(
              and(eq(operations.sessionId, session.id), inArray(operations.status, ['queued', 'offered'])),
            )
            .for('update');
          for (const op of pending) {
            if (Date.now() - Date.parse(op.createdAt) < 600_000) continue;
            await tx
              .update(operations)
              .set({ status: 'expired', updatedAt: now() })
              .where(eq(operations.id, op.id));
            await tx
              .update(sessions)
              .set({ status: 'failed', lastActivityAt: now() })
              .where(and(eq(sessions.id, session.id), eq(sessions.status, 'queued')));
          }
        });
      }

      if (['running', 'idle', 'waiting'].includes(session.status) && session.sessionId) {
        const prompts = await this.db
          .select()
          .from(agentPrompts)
          .where(and(eq(agentPrompts.sessionId, session.sessionId), eq(agentPrompts.status, 'open')));
        if (session.status !== 'running') {
          const status = prompts.length ? 'waiting' : 'idle';
          if (session.status !== status) {
            await this.db
              .update(sessions)
              .set({ status })
              .where(and(eq(sessions.id, session.id), eq(sessions.status, session.status)));
            session.status = status;
          }
        }
        if (
          prompts.some(
            (p) => Date.now() - Date.parse(p.createdAt) >= config.settings.question_minutes * 60_000,
          )
        ) {
          await this.stop(session.id, undefined, session, 'timeout');
          continue;
        }
      }
      if (!['idle', 'waiting'].includes(session.status)) continue;
      const pending = session.addressId
        ? await this.db
            .select({ id: agentBusMessages.id })
            .from(agentBusMessages)
            .where(
              and(
                eq(agentBusMessages.targetAddressId, session.addressId),
                inArray(agentBusMessages.status, ['queued', 'leased', 'accepted']),
              ),
            )
            .limit(1)
        : [];
      if (pending.length) continue;
      const minutes =
        session.status === 'waiting' ? config.settings.question_minutes : config.settings.idle_minutes;
      if (!config.settings.enabled || Date.now() - Date.parse(session.lastActivityAt) >= minutes * 60_000)
        await this.stop(session.id, undefined, session, 'timeout');
    }
  }
  changed(hostId: number) {
    wsPublisher.publish('host.daemon.changed', { host_id: hostId });
  }
}
