import { stagePortalEvent } from '../state/portal-events.js';
import { randomUUID, createHash } from 'node:crypto';
import { eq, inArray, and, desc } from 'drizzle-orm';
import {
  hostDaemonSessions,
  hostDaemonOperations,
  adminEvents,
  companionDaemonFollows,
  companionFollows,
  hostDaemonPortalBindings,
  agentEvents,
  agentPrompts,
} from '../../db/schema.js';
import { mutateOwnerState, type OwnerMutationContext } from '../state/runtime.js';
import { stageUpdate } from '../state/rows.js';
import { DaemonState } from './daemon-state.js';
import { daemonAccepting } from '../../services/host-daemon/policy.js';
import { isInternalHost } from '../../services/internal-hosts.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import { assertEngine } from './authorization.js';
import { ENGINE_HOST_FIELDS, type Engine } from '../../util/engine.js';
import { ownerPresence } from '../presence.js';
import type { StateRow } from '../state/catalog.js';
import { encrypt, decrypt } from '../../security/secret-box.js';
import type { PortalDaemonInput } from '../../services/host-daemon/service.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { Json } from '../commands.js';
import { stageAdvisorSessionStopped, stageAdvisorTurnCompleted } from '../../services/advisor-delivery.js';
import { stageAttachmentLink } from './attachments.js';
import { ChatAttachments } from '../../services/agent-chat/attachments.js';
import { validAnswer } from '../../services/agent-chat/contracts.js';
import { daemonExecutionEnabled } from '../../services/host-daemon/policy.js';
import { assertPermissionMode, planModePrompt, storedPermissionMode, type DaemonPermissionMode } from '../../services/host-daemon/permission-mode.js';
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class DaemonOperations extends DaemonState {
  portalEvent(c: OwnerMutationContext, sessionId: string, operationId: string, input: PortalDaemonInput) {
    c.write((tx) =>
      tx
        .insert(agentEvents)
        .values({
          sessionId,
          clientEventId: `daemon:${operationId}`,
          eventType: 'user_message',
          source: 'portal',
          payloadEnc: encrypt(
            JSON.stringify({
              text: input.content,
              ...(input.metadata ?? {}),
              author: input.author,
              message_id: operationId,
              delivery_status: 'queued',
              ...(input.promptId ? { prompt_id: input.promptId } : {}),
            }),
            this.ctx.keyring,
          ),
          createdAt: now(),
        })
        .onDuplicateKeyUpdate({ set: { clientEventId: `daemon:${operationId}` } }),
    );
  }
  bindPortal(c: OwnerMutationContext, daemonSessionId: string, portalSessionId: string) {
    if (!c.draft.table('agentSessions').has(portalSessionId)) return;
    c.draft.upsert('hostDaemonPortalBindings', { daemonSessionId, portalSessionId });
    c.write((tx) =>
      tx
        .insert(hostDaemonPortalBindings)
        .values({ daemonSessionId, portalSessionId })
        .onDuplicateKeyUpdate({ set: { daemonSessionId } }),
    );
    for (const f of c.draft.table('companionDaemonFollows').by('daemonSessionId', daemonSessionId)) {
      c.draft.upsert('companionFollows', { deviceId: f.deviceId, sessionId: portalSessionId });
      c.write((tx) =>
        tx
          .insert(companionFollows)
          .values({ deviceId: f.deviceId, sessionId: portalSessionId })
          .onDuplicateKeyUpdate({ set: { sessionId: portalSessionId } }),
      );
    }
  }
  mobile(c: OwnerMutationContext, hostId: number, engine: Engine, config: StateRow<'hostDaemons'>) {
    const host = this.workAccess(c.snapshot, hostId, engine),
      runtime = config.runtime;
    if (
      !runtime ||
      !ownerPresence(this.owner).hasDaemon(hostId, runtime.instance_id) ||
      runtime.error ||
      runtime.username !== config.settings.username
    )
      throw new ConflictError('Host daemon is not reachable', 'daemon_unreachable');
    if (!runtime.engines.includes(engine) || (host.secure && !host[ENGINE_HOST_FIELDS[engine].authDigest]))
      throw new ConflictError('Engine is not ready on this host', 'daemon_engine_unavailable');
    if (
      c.snapshot
        .table('hostDaemonSessions')
        .by('hostId', hostId)
        .filter((s) => ['queued', 'running', 'stopping'].includes(s.status)).length >=
      config.settings.max_parallel
    )
      throw new ConflictError('Host has no free slots', 'daemon_busy');
  }
  follow(c: OwnerMutationContext, deviceId: string, daemonSessionId: string) {
    c.draft.upsert('companionDaemonFollows', { deviceId, daemonSessionId });
    c.write((tx) =>
      tx
        .insert(companionDaemonFollows)
        .values({ deviceId, daemonSessionId })
        .onDuplicateKeyUpdate({ set: { daemonSessionId } }),
    );
  }
  async start(
    input: {
      host_id: number;
      engine: Engine;
      cwd?: string;
      title: string;
      prompt: string;
      client_message_id: string;
      permission_mode?: DaemonPermissionMode;
    },
    actor: string,
    portalInput?: PortalDaemonInput,
    options: { internal?: boolean; model?: string } = {},
  ) {
    const result = await mutateOwnerState(this.owner, {
      kind: 'daemon.operation.start',
      payload: { input, actor, portalInput: portalInput ?? null, options } as unknown as Json,
      prepare: (c) => this.stageStart(c, input, actor, portalInput, options),
    });
    this.changed(input.host_id);
    wsPublisher.publish('host.daemon.operation.queued', { host_id: input.host_id });
    return result as { operation_id: string; session_id: string };
  }
  stageStart(
    c: OwnerMutationContext,
    input: {
      host_id: number;
      engine: Engine;
      cwd?: string;
      title: string;
      prompt: string;
      client_message_id: string;
      permission_mode?: DaemonPermissionMode;
    },
    actor: string,
    portalInput?: PortalDaemonInput,
    options: { internal?: boolean; model?: string } = {},
  ) {
    const host = this.workAccess(c.snapshot, input.host_id, input.engine);
    if (isInternalHost(host) !== Boolean(options.internal)) throw new NotFoundError('Host not found');
    const config = this.eligible(input.host_id, input.engine, false, c.snapshot),
      locked = c.snapshot.daemons.get(input.host_id);
    if (!locked || !daemonAccepting(locked.settings)) throw new ForbiddenError('Host daemon disabled');
    const cwd = input.cwd || config.settings.default_cwd;
    if (cwd && (!cwd.startsWith('/') || cwd.includes('\0')))
      throw new ValidationError('Working directory must be absolute when specified');
    const clientKey = `${actor}:${input.client_message_id}`,
      requestHash = hash(input);
    const existing = c.snapshot
      .table('hostDaemonOperations')
      .all()
      .find((o) => o.clientKey === clientKey);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ConflictError('Idempotency key reused with different input');
      if (portalInput) this.follow(c, portalInput.deviceId, existing.sessionId);
      return { operation_id: existing.id, session_id: existing.sessionId };
    }
    if (portalInput) this.mobile(c, input.host_id, input.engine, locked);
    assertPermissionMode(input.engine, input.permission_mode, locked.runtime);
    const id = randomUUID(),
      opId = randomUUID(),
      at = now();
    const session = {
      id,
      hostId: input.host_id,
      owner: actor,
      engine: input.engine,
      username: locked.settings.username,
      cwd,
      title: input.title,
      model: options.model ?? null,
      permissionMode: storedPermissionMode(input.permission_mode),
      status: 'queued',
      lastActivityAt: at,
      createdAt: at,
      addressId: null,
      sessionId: null,
      activeMessageId: null,
    };
    const operation = {
      id: opId,
      sessionId: id,
      hostId: input.host_id,
      clientKey,
      requestHash,
      promptEnc: encrypt(input.prompt, this.ctx.keyring),
      portalContentEnc: portalInput ? encrypt(JSON.stringify(portalInput), this.ctx.keyring) : null,
      status: 'queued',
      claimId: null,
      resultEnc: null,
      createdAt: at,
      updatedAt: at,
    };
    c.draft.upsert('hostDaemonSessions', session);
    c.draft.upsert('hostDaemonOperations', operation);
    c.write(async (tx) => {
      await tx.insert(hostDaemonSessions).values(session);
      await tx.insert(hostDaemonOperations).values(operation);
      await tx.insert(adminEvents).values({
        type: 'host.daemon.start_requested',
        hostId: input.host_id,
        payload: { owner: actor, session_id: id, operation_id: opId, engine: input.engine },
        createdAt: at,
      });
    });
    if (portalInput) this.follow(c, portalInput.deviceId, id);
    return { operation_id: opId, session_id: id };
  }
  async session(id: string, actor?: string) {
    this.owner.assertOwner();
    const s = this.owner.state.snapshot(),
      row = s.table('hostDaemonSessions').get(id);
    if (!row) throw new NotFoundError('Remote session not found');
    if (actor && row.owner !== actor)
      throw new ForbiddenError('Only the creating agent may control this helper');
    const ops = [...s.table('hostDaemonOperations').by('sessionId', id)].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const results = ops.length
      ? await this.ctx.db
          .select({ id: hostDaemonOperations.id, resultEnc: hostDaemonOperations.resultEnc })
          .from(hostDaemonOperations)
          .where(
            inArray(
              hostDaemonOperations.id,
              ops.map((o) => o.id),
            ),
          )
      : [];
    return {
      ...row,
      address: row.addressId ? `agent:${row.addressId}` : null,
      operations: ops.map((op) => {
        const enc = results.find((r) => r.id === op.id)?.resultEnc;
        return { ...op, result: enc ? (JSON.parse(decrypt(enc, this.ctx.keyring)) as unknown) : null };
      }),
    };
  }
  async offer(id: number, generation: string) {
    this.eligible(id);
    const before = this.owner.state.snapshot();
    const op = [...before.table('hostDaemonOperations').by('hostId', id)]
      .filter((o) => ['offered', 'queued'].includes(o.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!op) return null;
    const cold = (
      await this.ctx.db
        .select({ promptEnc: hostDaemonOperations.promptEnc })
        .from(hostDaemonOperations)
        .where(eq(hostDaemonOperations.id, op.id))
    )[0];
    if (!cold) throw new ConflictError('Operation content unavailable');
    return (await mutateOwnerState(this.owner, {
      kind: 'daemon.operation.offer',
      payload: { id, generation, operationId: op.id },
      prepare: (c) => {
        const host = this.workAccess(c.snapshot, id),
          config = this.eligible(id, undefined, false, c.snapshot),
          current = c.snapshot.daemons.get(id);
        if (!current || !daemonAccepting(current.settings) || current.runtime?.generation !== generation)
          throw new ConflictError('Daemon generation changed');
        const row = c.snapshot.table('hostDaemonOperations').get(op.id);
        if (!row || !['offered', 'queued'].includes(row.status) || row.requestHash !== op.requestHash)
          return null;
        const work = c.snapshot.table('hostDaemonSessions').by('hostId', id),
          session = work.find((s) => s.id === row.sessionId);
        if (!session) throw new ConflictError('Daemon session unavailable');
        if (Date.now() - Date.parse(row.createdAt) >= 600000) {
          stageUpdate(c, 'hostDaemonOperations', row.id, { status: 'expired', updatedAt: now() });
          stageUpdate(c, 'hostDaemonSessions', session.id, { status: 'failed' });
          return null;
        }
        if (
          work.filter((s) => ['running', 'stopping'].includes(s.status)).length >=
          config.settings.max_parallel
        )
          return null;
        assertEngine(c.snapshot, host, session.engine);
        if (!config.runtime?.engines.includes(session.engine)) return null;
        // An older wrapper would ignore the mode and run at the host's level.
        if (session.permissionMode === 'plan' && (config.runtime.permission_mode_version ?? 0) < 1) return null;
        const claimId = row.claimId ?? randomUUID();
        if (row.status !== 'offered' || !row.claimId)
          stageUpdate(c, 'hostDaemonOperations', row.id, { status: 'offered', claimId, updatedAt: now() });
        const address = session.addressId ? c.snapshot.addresses.get(session.addressId) : undefined;
        return {
          operation_id: row.id,
          claim_id: claimId,
          session_id: session.id,
          engine: session.engine,
          cwd: session.cwd,
          title: session.title,
          model: session.model ?? '',
          permission_mode: session.permissionMode ?? '',
          prompt: planModePrompt(decrypt(cold.promptEnc, this.ctx.keyring), session.permissionMode),
          address: address ? `agent:${address.id}` : '',
          binding_generation: address?.bindingGeneration ?? 0,
          upstream_session_id: address?.lastUpstreamSessionId ?? '',
        };
      },
    })) as {
      operation_id: string;
      claim_id: string;
      session_id: string;
      engine: string;
      cwd: string;
      title: string;
      model: string;
      permission_mode: string;
      prompt: string;
      address: string;
      binding_generation: number;
      upstream_session_id: string;
    } | null;
  }
  async accept(hostId: number, id: string, claim: string) {
    return mutateOwnerState(this.owner, {
      kind: 'daemon.operation.accept',
      payload: { hostId, id, claim },
      prepare: (c) => {
        this.eligible(hostId, undefined, true, c.snapshot);
        const config = c.snapshot.daemons.get(hostId),
          op = c.snapshot.table('hostDaemonOperations').get(id);
        if (!op || op.hostId !== hostId || op.claimId !== claim)
          throw new ForbiddenError('Invalid operation claim');
        if (op.status === 'accepted') return { accepted: true };
        if (op.status !== 'offered') throw new ConflictError('Operation is no longer offered');
        const host = this.workAccess(c.snapshot, hostId),
          target = c.snapshot.table('hostDaemonSessions').get(op.sessionId);
        if (!target || target.status !== 'queued') throw new ConflictError('Session is no longer queued');
        assertEngine(c.snapshot, host, target.engine);
        const running = c.snapshot
          .table('hostDaemonSessions')
          .by('hostId', hostId)
          .filter((s) => ['running', 'stopping'].includes(s.status));
        if (!config || !daemonAccepting(config.settings) || running.length >= config.settings.max_parallel)
          throw new ConflictError('No work slot available');
        stageUpdate(c, 'hostDaemonOperations', id, { status: 'accepted', updatedAt: now() });
        stageUpdate(c, 'hostDaemonSessions', op.sessionId, { status: 'running', lastActivityAt: now() });
        return { accepted: true };
      },
    });
  }
  async turn(
    id: string,
    prompt: string,
    clientId: string,
    actor?: string,
    portalInput?: PortalDaemonInput,
    guard?: (context: OwnerMutationContext) => void,
  ) {
    const questionCold = portalInput?.promptId
      ? (
          await this.ctx.db
            .select({ choicesEnc: agentPrompts.choicesEnc, optionsEnc: agentPrompts.optionsEnc })
            .from(agentPrompts)
            .where(eq(agentPrompts.id, portalInput.promptId))
        )[0]
      : undefined;
    let hostId = 0;
    const result = await mutateOwnerState(this.owner, {
      kind: 'daemon.operation.turn',
      payload: {
        id,
        prompt,
        clientId,
        actor: actor ?? null,
        portalInput: portalInput ?? null,
      } as unknown as Json,
      prepare: (c) => {
        guard?.(c);
        const locked = c.snapshot.table('hostDaemonSessions').get(id);
        if (!locked) throw new NotFoundError('Remote session not found');
        if (actor && locked.owner !== actor)
          throw new ForbiddenError('Only the creating agent may control this helper');
        hostId = locked.hostId;
        this.workAccess(c.snapshot, hostId, locked.engine as Engine);
        const config = c.snapshot.daemons.get(hostId);
        if (!config || !daemonAccepting(config.settings)) throw new ForbiddenError('Host daemon disabled');
        const key = `${actor ?? 'admin'}:${clientId}`,
          requestHash = hash({ id, prompt }),
          prior = c.snapshot
            .table('hostDaemonOperations')
            .all()
            .find((o) => o.clientKey === key);
        if (prior) {
          if (prior.requestHash !== requestHash) throw new ConflictError('Idempotency key reused');
          return { operation_id: prior.id, session_id: id };
        }
        if (['running', 'stopping', 'queued'].includes(locked.status))
          throw new ConflictError('Session is busy');
        if (portalInput) {
          if (!['idle', 'waiting'].includes(locked.status))
            throw new ConflictError('Session cannot be resumed', 'daemon_session_unavailable');
          this.mobile(c, hostId, locked.engine as Engine, config);
        }
        if (!locked.addressId) throw new ConflictError('No native transcript to resume');
        if (!c.snapshot.addresses.get(locked.addressId)?.lastUpstreamSessionId)
          throw new ConflictError('Native transcript missing');
        const opId = randomUUID(),
          at = now();
        if (portalInput && locked.sessionId) {
          if (portalInput.promptId) {
            const q = c.snapshot.table('agentPrompts').get(portalInput.promptId);
            if (!q || q.sessionId !== locked.sessionId || q.status !== 'open')
              throw new ConflictError('Prompt was already answered', 'already_answered');
            if (portalInput.version !== undefined && q.version !== portalInput.version)
              throw new ConflictError('Prompt version changed', 'prompt_version_conflict');
            const choices = questionCold?.choicesEnc
              ? JSON.parse(decrypt(questionCold.choicesEnc, this.ctx.keyring))
              : questionCold?.optionsEnc
                ? JSON.parse(decrypt(questionCold.optionsEnc, this.ctx.keyring)).map((value: string) => ({
                    label: value,
                    value,
                  }))
                : [];
            if (
              !validAnswer(
                q.answerMode ?? 'both',
                choices,
                portalInput.content,
                portalInput.metadata?.choice_value,
              )
            )
              throw new ValidationError('Invalid question answer');
            stageUpdate(c, 'agentPrompts', q.id, {
              status: 'answered',
              answeredAt: at,
              version: q.version + 1,
            });
          }
          stageAttachmentLink(
            c,
            locked.sessionId,
            portalInput.metadata ?? {},
            new ChatAttachments(this.ctx.db, this.ctx.keyring, this.ctx.env.DATA_ROOT ?? 'storage').limits()
              .max_total_bytes,
            actor,
          );
          this.portalEvent(c, locked.sessionId, opId, portalInput);
          this.follow(c, portalInput.deviceId, id);
        }
        const operation = {
          id: opId,
          sessionId: id,
          hostId,
          clientKey: key,
          requestHash,
          promptEnc: encrypt(prompt, this.ctx.keyring),
          portalContentEnc: portalInput ? encrypt(JSON.stringify(portalInput), this.ctx.keyring) : null,
          status: 'queued',
          claimId: null,
          resultEnc: null,
          createdAt: at,
          updatedAt: at,
        };
        c.draft.upsert('hostDaemonOperations', operation);
        c.write((tx) => tx.insert(hostDaemonOperations).values(operation));
        stageUpdate(c, 'hostDaemonSessions', id, { status: 'queued', lastActivityAt: at });
        c.write((tx) =>
          tx.insert(adminEvents).values({
            type: 'host.daemon.start_requested',
            hostId,
            payload: { owner: actor ?? 'operator', session_id: id, operation_id: opId, kind: 'resume' },
            createdAt: at,
          }),
        );
        return { operation_id: opId, session_id: id };
      },
    });
    this.changed(hostId);
    wsPublisher.publish('host.daemon.operation.queued', { host_id: hostId });
    return result as { operation_id: string; session_id: string };
  }
  async stop(
    id: string,
    actorOwner?: string,
    expected?: { status: string; lastActivityAt: string },
    actor = actorOwner ?? 'operator',
  ) {
    let hostId = 0;
    await mutateOwnerState(this.owner, {
      kind: 'daemon.session.stop',
      payload: { id, actorOwner: actorOwner ?? null, expected: expected ?? null, actor },
      prepare: (c) => {
        hostId = this.stageStop(c, id, actorOwner, expected, actor);
        return null;
      },
    });
    this.changed(hostId);
    return this.session(id, actorOwner);
  }
  async setPermissionMode(id: string, mode: DaemonPermissionMode, actorOwner?: string, actor = actorOwner ?? 'operator') {
    let hostId = 0;
    const changed = (await mutateOwnerState(this.owner, {
      kind: 'daemon.session.permission_mode',
      payload: { id, mode, actorOwner: actorOwner ?? null, actor },
      prepare: (c) => {
        const current = c.snapshot.table('hostDaemonSessions').get(id);
        if (!current) throw new NotFoundError('Remote session not found');
        if (actorOwner && current.owner !== actorOwner) throw new ForbiddenError('Only the creating agent may control this helper');
        hostId = current.hostId;
        if (['closed', 'failed', 'unknown'].includes(current.status))
          throw new ConflictError('Session has ended', 'daemon_session_unavailable');
        if ((current.permissionMode ?? 'default') === mode) return false;
        assertPermissionMode(current.engine, mode, c.snapshot.daemons.get(current.hostId)?.runtime);
        stageUpdate(c, 'hostDaemonSessions', id, { permissionMode: storedPermissionMode(mode) });
        c.write((tx) =>
          tx.insert(adminEvents).values({
            type: 'host.daemon.permission_mode_changed',
            hostId: current.hostId,
            payload: { session_id: id, permission_mode: mode, actor },
            createdAt: now(),
          }),
        );
        return true;
      },
    })) as boolean;
    if (changed) this.changed(hostId);
    return { session_id: id, permission_mode: mode, changed };
  }
  stageStop(
    c: OwnerMutationContext,
    id: string,
    actorOwner?: string,
    expected?: { status: string; lastActivityAt: string },
    actor = actorOwner ?? 'operator',
  ) {
    const current = c.snapshot.table('hostDaemonSessions').get(id);
    if (!current) throw new NotFoundError('Remote session not found');
    if (actorOwner && current.owner !== actorOwner)
      throw new ForbiddenError('Only the creating agent may control this helper');
    const hostId = current.hostId;
    if (
      current.status === 'closed' ||
      (expected && (current.status !== expected.status || current.lastActivityAt !== expected.lastActivityAt))
    )
      return hostId;
    for (const op of c.snapshot
      .table('hostDaemonOperations')
      .by('sessionId', id)
      .filter((o) => ['queued', 'offered'].includes(o.status)))
      stageUpdate(c, 'hostDaemonOperations', op.id, { status: 'canceled', updatedAt: now() });
    stageUpdate(c, 'hostDaemonSessions', id, {
      status: ['running', 'stopping'].includes(current.status) ? 'stopping' : 'closed',
    });
    stageAdvisorSessionStopped(c, this.ctx.keyring, current, actor);
    c.write((tx) =>
      tx.insert(adminEvents).values({
        type: 'host.daemon.stop_requested',
        hostId,
        payload: { session_id: id, actor },
        createdAt: now(),
      }),
    );
    return hostId;
  }
  async bind(hostId: number, operationId: string, claim: string, sessionId: string, addressId: string) {
    const cold = (
      await this.ctx.db
        .select({ portalContentEnc: hostDaemonOperations.portalContentEnc })
        .from(hostDaemonOperations)
        .where(eq(hostDaemonOperations.id, operationId))
    )[0];
    await mutateOwnerState(this.owner, {
      kind: 'daemon.operation.bind',
      payload: { hostId, operationId, claim, sessionId, addressId },
      prepare: (c) => {
        const op = c.snapshot.table('hostDaemonOperations').get(operationId);
        if (!op || op.hostId !== hostId || op.claimId !== claim || op.status !== 'accepted')
          throw new ForbiddenError('Invalid daemon launch binding');
        const remote = c.snapshot.table('hostDaemonSessions').get(op.sessionId);
        if (!remote) throw new ConflictError('Daemon session unavailable');
        const native = c.snapshot.sessions.get(sessionId);
        if (native && native.hostId !== hostId) throw new ForbiddenError('Native host binding mismatch');
        stageUpdate(c, 'hostDaemonSessions', remote.id, {
          sessionId,
          addressId,
          ...(!remote.cwd && native?.cwd.startsWith('/') && !native.cwd.includes('\0')
            ? { cwd: native.cwd }
            : {}),
        });
        this.bindPortal(c, remote.id, sessionId);
        if (native && cold?.portalContentEnc) {
          this.portalEvent(
            c,
            sessionId,
            operationId,
            JSON.parse(decrypt(cold.portalContentEnc, this.ctx.keyring)) as PortalDaemonInput,
          );
          c.write((tx) =>
            tx
              .insert(agentEvents)
              .values({
                sessionId,
                clientEventId: `daemon:accepted:${operationId}`,
                eventType: 'message_accepted',
                source: 'bridge',
                payloadEnc: encrypt(JSON.stringify({ message_id: operationId }), this.ctx.keyring),
                createdAt: now(),
              })
              .onDuplicateKeyUpdate({ set: { clientEventId: `daemon:accepted:${operationId}` } }),
          );
        }
        return null;
      },
    });
    this.changed(hostId);
  }
  async bindPeer(hostId: number, sessionId: string, addressId: string) {
    const remote = this.owner.state
      .snapshot()
      .table('hostDaemonSessions')
      .by('hostId', hostId)
      .find((r) => r.addressId === addressId && r.status === 'running');
    if (!remote) return false;
    const result = await mutateOwnerState(this.owner, {
      kind: 'daemon.session.bind_peer',
      payload: { hostId, sessionId, addressId },
      prepare: (c) => {
        const row = c.snapshot.table('hostDaemonSessions').get(remote.id);
        if (!row || row.hostId !== hostId || row.addressId !== addressId || row.status !== 'running')
          return false;
        stageUpdate(c, 'hostDaemonSessions', row.id, { sessionId });
        this.bindPortal(c, row.id, sessionId);
        return true;
      },
    });
    this.changed(hostId);
    return result as boolean;
  }
  async peerFinished(hostId: number, id: string, messageId: string) {
    await mutateOwnerState(this.owner, {
      kind: 'daemon.session.peer_finished',
      payload: { hostId, id, messageId },
      prepare: (c) => {
        const session = c.snapshot.table('hostDaemonSessions').get(id),
          message = c.snapshot.messages.get(messageId);
        if (
          !session ||
          session.hostId !== hostId ||
          !message ||
          message.targetAddressId !== session.addressId
        )
          throw new ForbiddenError('Remote delivery mismatch');
        if (session.activeMessageId !== messageId) return null;
        if (['leased', 'accepted'].includes(message.status)) throw new ConflictError('Delivery still active');
        const config = c.snapshot.daemons.get(hostId);
        stageUpdate(c, 'hostDaemonSessions', id, {
          status:
            session.status === 'stopping' || !config || !daemonExecutionEnabled(config.settings)
              ? 'closed'
              : message.status === 'ambiguous'
                ? 'unknown'
                : 'idle',
          activeMessageId: null,
          lastActivityAt: now(),
        });
        return null;
      },
    });
    this.changed(hostId);
    return { stored: true };
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
    const cold = (
      await this.ctx.db
        .select({
          resultEnc: hostDaemonOperations.resultEnc,
          portalContentEnc: hostDaemonOperations.portalContentEnc,
        })
        .from(hostDaemonOperations)
        .where(eq(hostDaemonOperations.id, id))
    )[0];
    const encoded = encrypt(JSON.stringify(result), this.ctx.keyring);
    await mutateOwnerState(this.owner, {
      kind: 'daemon.operation.complete',
      payload: { hostId, id, claim, result },
      prepare: (c) => {
        const op = c.snapshot.table('hostDaemonOperations').get(id);
        if (!op || op.hostId !== hostId || op.claimId !== claim)
          throw new ForbiddenError('Invalid operation claim');
        if (op.status === 'reboot_hold') return null;
        if (cold?.resultEnc) {
          if (decrypt(cold.resultEnc, this.ctx.keyring) !== JSON.stringify(result))
            throw new ConflictError('Result already stored');
          return null;
        }
        if (['canceled', 'expired'].includes(op.status) && result.status === 'unknown') return null;
        if (op.status === 'offered' && result.status !== 'unknown')
          throw new ConflictError('Operation was not accepted');
        if (!['accepted', 'offered'].includes(op.status))
          throw new ConflictError('Operation is no longer active');
        const session = c.snapshot.table('hostDaemonSessions').get(op.sessionId),
          config = c.snapshot.daemons.get(hostId),
          at = now();
        if (result.status === 'completed' && result.upstream_session_id && session?.addressId) {
          const address = c.snapshot.addresses.get(session.addressId);
          if (
            !address ||
            address.enabled !== 1 ||
            address.archivedAt ||
            address.hostId !== hostId ||
            address.engine !== session.engine ||
            (address.currentSessionId && address.currentSessionId !== session.sessionId) ||
            (address.lastUpstreamSessionId && address.lastUpstreamSessionId !== result.upstream_session_id)
          )
            throw new ConflictError('Native completion binding changed');
          stageUpdate(c, 'agentBusAddresses', address.id, {
            lastUpstreamSessionId: result.upstream_session_id,
            continuity: 'native',
            readiness: address.currentSessionId ? address.readiness : 'resumable',
            updatedAt: at,
          });
          const portal = session.sessionId ? c.snapshot.sessions.get(session.sessionId) : undefined;
          if (portal && !portal.upstreamSessionId) {
            stageUpdate(c, 'agentSessions', portal.id, { upstreamSessionId: result.upstream_session_id });
            c.write(async (tx) => {
              const [named] = await tx
                .select({ payloadEnc: agentEvents.payloadEnc })
                .from(agentEvents)
                .where(and(eq(agentEvents.sessionId, portal.id), eq(agentEvents.eventType, 'session_named')))
                .orderBy(desc(agentEvents.id))
                .limit(1);
              const naming = named
                ? (JSON.parse(decrypt(named.payloadEnc, this.ctx.keyring)) as Record<string, unknown>)
                : null;
              if (naming && naming.native_session_id == null)
                stagePortalEvent(c, {
                  sessionId: portal.id,
                  clientEventId: `daemon:native-name:${id}`,
                  eventType: 'session_named',
                  source: 'bridge',
                  payloadEnc: encrypt(
                    JSON.stringify({ ...naming, native_session_id: result.upstream_session_id }),
                    this.ctx.keyring,
                  ),
                  createdAt: at,
                });
            });
          }
        }
        stageUpdate(c, 'hostDaemonOperations', id, {
          status: result.status,
          resultEnc: encoded,
          updatedAt: at,
        });
        if (
          cold?.portalContentEnc &&
          session?.sessionId &&
          c.snapshot.table('hostDaemonPortalBindings').get(session.sessionId)?.daemonSessionId ===
            session.id &&
          result.status === 'completed' &&
          result.reply.trim()
        ) {
          const portalSessionId = session.sessionId;
          c.write(async (tx) => {
            const [reply] = await tx
              .select({ id: agentEvents.id })
              .from(agentEvents)
              .where(
                and(
                  eq(agentEvents.sessionId, portalSessionId),
                  eq(agentEvents.eventType, 'assistant_message'),
                ),
              )
              .limit(1);
            if (!reply)
              stagePortalEvent(c, {
                sessionId: portalSessionId,
                clientEventId: `daemon:result:${op.id}`,
                eventType: 'assistant_message',
                source: 'bridge',
                payloadEnc: encrypt(
                  JSON.stringify({
                    text: result.reply,
                    message_id: op.id,
                    summary: 'New reply from the agent.',
                  }),
                  this.ctx.keyring,
                ),
                createdAt: at,
              });
          });
        }
        const prompts = session?.sessionId
          ? c.snapshot
              .table('agentPrompts')
              .by('sessionId', session.sessionId)
              .filter((p) => p.status === 'open')
          : [];
        const status =
          session?.status === 'stopping' ||
          result.status === 'stopped' ||
          !config ||
          !daemonExecutionEnabled(config.settings)
            ? 'closed'
            : result.status === 'completed'
              ? prompts.length
                ? 'waiting'
                : 'idle'
              : result.status;
        if (session) {
          stageAdvisorTurnCompleted(
            c,
            this.ctx.keyring,
            session,
            result,
            status,
            config?.settings.idle_minutes ?? 60,
          );
          stageUpdate(c, 'hostDaemonSessions', session.id, { status, lastActivityAt: at });
        }
        return null;
      },
    });
    this.changed(hostId);
    return { stored: true };
  }
  async sweep(hostId: number) {
    await this.expirePending(hostId);
    const config = this.settings(hostId),
      snapshot = this.owner.state.snapshot(),
      at = Date.now();
    const expired = new Set(
      snapshot
        .table('hostDaemonSessions')
        .by('hostId', hostId)
        .filter(
          (s) =>
            ['closed', 'failed', 'unknown'].includes(s.status) &&
            at - Date.parse(s.lastActivityAt) > this.ctx.env.AGENT_PORTAL_RETENTION_HOURS * 3600000,
        )
        .map((s) => s.id),
    );
    const retire = snapshot
      .table('hostDaemonOperations')
      .by('hostId', hostId)
      .filter(
        (o) =>
          expired.has(o.sessionId) &&
          ['completed', 'failed', 'unknown', 'stopped', 'canceled', 'expired'].includes(o.status),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 500);
    const overdue = snapshot
      .table('hostDaemonOperations')
      .by('hostId', hostId)
      .filter((o) => ['queued', 'offered'].includes(o.status) && at - Date.parse(o.createdAt) >= 600000);
    if (retire.length || overdue.length)
      await mutateOwnerState(this.owner, {
        kind: 'daemon.operations.expire',
        payload: { hostId },
        prepare: (c) => {
          for (const prior of retire) {
            const row = c.snapshot.table('hostDaemonOperations').get(prior.id);
            if (row && row.status === prior.status && row.updatedAt === prior.updatedAt)
              stageUpdate(c, 'hostDaemonOperations', row.id, {
                promptEnc: '',
                resultEnc: null,
                claimId: null,
                status: 'retired',
              });
          }
          for (const prior of overdue) {
            const row = c.snapshot.table('hostDaemonOperations').get(prior.id),
              session = row ? c.snapshot.table('hostDaemonSessions').get(row.sessionId) : undefined;
            if (
              row &&
              ['queued', 'offered'].includes(row.status) &&
              session?.status === 'queued' &&
              Date.now() - Date.parse(row.createdAt) >= 600000
            ) {
              stageUpdate(c, 'hostDaemonOperations', row.id, { status: 'expired', updatedAt: now() });
              stageUpdate(c, 'hostDaemonSessions', session.id, { status: 'failed', lastActivityAt: now() });
            }
          }
          return null;
        },
      });
    for (const previous of this.owner.state.snapshot().table('hostDaemonSessions').by('hostId', hostId)) {
      let session = previous;
      const state = this.owner.state.snapshot();
      const prompts = session.sessionId
        ? state
            .table('agentPrompts')
            .by('sessionId', session.sessionId)
            .filter((p) => p.status === 'open')
        : [];
      if (['running', 'idle', 'waiting'].includes(session.status) && session.sessionId) {
        if (session.status !== 'running') {
          const status = prompts.length ? 'waiting' : 'idle';
          if (status !== session.status) {
            await mutateOwnerState(this.owner, {
              kind: 'daemon.session.prompt_state',
              payload: { id: session.id, status },
              prepare: (c) => {
                const row = c.snapshot.table('hostDaemonSessions').get(session.id);
                if (row?.status === session.status) stageUpdate(c, 'hostDaemonSessions', row.id, { status });
                return null;
              },
            });
            session = { ...session, status };
          }
        }
        if (
          prompts.some(
            (p) => Date.now() - Date.parse(p.createdAt) >= config.settings.question_minutes * 60000,
          )
        ) {
          await this.stop(session.id, undefined, session, 'timeout');
          continue;
        }
      }
      if (!['idle', 'waiting'].includes(session.status)) continue;
      if (
        session.addressId &&
        state.messages
          .by('targetAddressId', session.addressId)
          .some((m) => ['queued', 'leased', 'accepted'].includes(m.status))
      )
        continue;
      const minutes =
        session.status === 'waiting' ? config.settings.question_minutes : config.settings.idle_minutes;
      if (
        !daemonAccepting(config.settings) ||
        Date.now() - Date.parse(session.lastActivityAt) >= minutes * 60000
      )
        await this.stop(session.id, undefined, session, 'timeout');
    }
  }
}
