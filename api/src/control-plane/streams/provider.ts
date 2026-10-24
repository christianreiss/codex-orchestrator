import { relayCommunicatorUsername } from './authorization.js';
import { ownerCredentials } from '../credentials.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OwnerRuntime } from '../state/runtime.js';
import type { StateFrame, StateProjection, StateProvider, StateScope } from '../protocol.js';
import { canonicalCommand, type Json } from '../commands.js';
import { ownerPresence } from '../presence.js';
import { StreamAuthorization } from './authorization.js';
import { schedulePolicy, watchdogPolicy } from './policies.js';
import { receiverState, RECEIVER_CLAIM_GATES } from '../../services/agent-receiver-state.js';
import { ForbiddenError } from '../../http/errors.js';

const receiverUpdate = z
  .object({
    generation: z.string(),
    gate: z
      .object({ state: z.enum(RECEIVER_CLAIM_GATES), seconds: z.number().int().min(0).max(604800) })
      .strict()
      .optional(),
    capacity: z.boolean().optional(),
    informational_only: z.boolean().optional(),
  })
  .strict();
const relayUpdate = z.object({ capacity: z.number().int().min(0).max(64) }).strict();
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

/** One authenticated transport; projections contain no credentials or SQL access. */
export class OwnerStateProvider implements StateProvider {
  readonly epoch: string;
  constructor(
    readonly runtime: OwnerRuntime,
    readonly authorization: StreamAuthorization,
    readonly connectionId: string,
    readonly username: string,
  ) {
    this.epoch = runtime.state.revision().epoch;
  }
  assertOwner(): void {
    this.runtime.assertOwner();
  }
  async open(input: StateScope, auth: NonNullable<StateFrame['auth']>): Promise<StateProjection> {
    const scope = { ...input };
    const credentials = ownerCredentials(this.runtime);
    if ((scope.topic === 'session' || scope.topic === 'receiver') && scope.session_id) {
      scope.binding_generation ??= this.runtime.state
        .snapshot()
        .sessions.get(scope.session_id)?.bindingGeneration;
      await credentials.renewBootstrap({
        kind: 'session',
        id: scope.session_id,
        token: auth.bridge_token ?? '',
        hostId: this.authorization.hostId,
        username: this.username,
        bindingGeneration: scope.binding_generation,
        authorizeHost: (snapshot) => {
          this.authorization.host(snapshot);
        },
      });
    } else if (scope.topic === 'relay' && scope.relay_id) {
      const relay = this.runtime.state.snapshot().table('agentBusRelays').get(scope.relay_id);
      if (!relay || relayCommunicatorUsername(relay) !== this.username)
        throw new ForbiddenError('Relay user does not own communicator');
      if (scope.native_instance_id !== relay.instanceId || scope.binding_generation !== relay.generation)
        throw new ForbiddenError('Relay instance changed');
      await credentials.renewBootstrap({
        kind: 'relay',
        id: scope.relay_id,
        token: auth.relay_token ?? '',
        hostId: this.authorization.hostId,
        username: relay.username,
        authorizeHost: (snapshot) => {
          this.authorization.host(snapshot);
        },
      });
    }
    const authorize = () => {
      if (scope.topic === 'session' || scope.topic === 'receiver') {
        const result = this.authorization.session(scope, auth.bridge_token);
        if (result.session.username !== this.username)
          throw new ForbiddenError('Session user does not own communicator');
        return result;
      }
      if (scope.topic === 'relay') return this.authorization.relay(scope, auth.relay_token, this.username);
      if (scope.topic === 'provider') return this.authorization.provider(scope);
      if (scope.topic === 'daemon') return this.authorization.daemon(scope, this.username);
      throw new ForbiddenError('Unsupported control state scope');
    };
    const admitted = authorize();
    if ('session' in admitted) scope.binding_generation = admitted.session.bindingGeneration ?? undefined;
    const presence = ownerPresence(this.runtime);
    const handle = presence.attach({
      connectionId: this.connectionId,
      hostId: this.authorization.hostId,
      username: 'relay' in admitted ? admitted.relay.username : this.username,
      scope,
    });
    let lastWork = '',
      workRevision = 0n,
      stopped = false;
    const key = `stream-obligation:${randomUUID()}`;
    let wake: (() => void) | undefined;
    const snapshot = (): Json => {
      const current = authorize(),
        state = this.runtime.state.snapshot();
      const now = Date.now(),
        deadlines: number[] = [];
      const due = (value: string | null | undefined) => {
        const n = Date.parse(value ?? '');
        if (n > now) deadlines.push(n);
        return n <= now;
      };
      let value: unknown;
      if ('session' in current) {
        const session = current.session,
          receiver = receiverState(session.receiver);
        if (scope.topic === 'session') {
          const control = state.table('agentNativeControls').get(session.id);
          const watchdog = watchdogPolicy(state, session, now);
          if (watchdog.watchdog) due(watchdog.watchdog.deadline_at);
          value = {
            session: {
              id: session.id,
              binding_generation: session.bindingGeneration,
              close_requested_at: session.closeRequestedAt,
              active_turn_id: session.activeTurnId,
            },
            receiver,
            native_control:
              control && control.bindingGeneration === session.bindingGeneration
                ? { instance_id: control.instanceId, request_id: control.requestId, status: control.status }
                : null,
            watchdog,
            schedule: schedulePolicy(state, session),
          };
        } else {
          const sources = Object.keys(receiver?.probes ?? {}).filter((source) =>
            source === 'peer'
              ? state.setting('agent_messaging_enabled') === '1' && !!session.agentBusAddressId
              : source === 'portal' &&
                state.setting('agent_portal_enabled') === '1' &&
                !receiver?.portal_closed,
          );
          const peer = session.agentBusAddressId
            ? state.messages.by('targetAddressId', session.agentBusAddressId)
            : [];
          const portal = state.table('agentMessages').by('sessionId', session.id);
          // This intentionally overapproximates claim eligibility. A false positive costs
          // one finite RAM claim; a false negative could strand durable work.
          const work = [...peer, ...portal]
            .filter((m) => ['queued', 'leased', 'accepted'].includes(m.status))
            .map((m) => [m.id, m.status, m.updatedAt, due(m.nextAttemptAt), due(m.leaseUntil)]);
          const fingerprint = canonicalCommand(json([sources, work]));
          if (lastWork !== fingerprint) {
            lastWork = fingerprint;
            workRevision++;
          }
          value = { work_revision: workRevision.toString(), sources };
        }
      } else if ('relay' in current) {
        const addresses = state.addresses
          .by('hostId', current.host.id)
          .filter((a) => a.username === this.username);
        const work = addresses.flatMap((a) =>
          state.messages
            .by('targetAddressId', a.id)
            .filter((m) => ['queued', 'leased', 'accepted'].includes(m.status))
            .map((m) => [m.id, m.status, m.updatedAt, due(m.nextAttemptAt), due(m.leaseUntil)]),
        );
        const fingerprint = canonicalCommand(
          json([
            addresses.map((a) => [
              a.id,
              a.bindingGeneration,
              a.enabled,
              a.archivedAt,
              a.currentSessionId,
              a.engine,
            ]),
            work,
            state
              .table('hostDaemonSessions')
              .by('hostId', current.host.id)
              .map((r) => [r.id, r.status, r.addressId]),
            state.daemons.get(current.host.id)?.settings ?? null,
            current.host.engines,
            state.setting('codex_engine_disabled'),
            state.setting('claude_engine_disabled'),
            state.setting('grok_engine_disabled'),
          ]),
        );
        if (lastWork !== fingerprint) {
          lastWork = fingerprint;
          workRevision++;
        }
        value = { work_revision: workRevision.toString() };
      } else if ('lease' in current) {
        value = {
          provider_session_id: current.lease.id,
          engine: current.lease.engine,
          account_id: current.lease.accountId,
        };
      } else {
        value = {
          settings: current.daemon.settings,
          stop: state
            .table('hostDaemonSessions')
            .by('hostId', current.host.id)
            .filter((s) => s.status === 'stopping')
            .map((s) => s.id),
          config_revision: canonicalCommand(
            json([current.host.configVersion, current.host.engines, current.daemon.settings]),
          ),
        };
      }
      this.runtime.deadlines.cancel(key);
      if (deadlines.length && !stopped)
        this.runtime.deadlines.schedule(key, Math.min(...deadlines), () => {
          wake?.();
        });
      return json(value);
    };
    return {
      authorize: () => ({ deadline: authorize().deadline }),
      snapshot,
      subscribe: (changed) => {
        let previous = '';
        const check = () => {
          if (stopped) return;
          try {
            const next = canonicalCommand(json([snapshot(), authorize().deadline]));
            if (next === previous) return;
            previous = next;
          } catch {
            /* Delegate revocation to transport so it closes this stream. */
          }
          changed();
        };
        wake = check;
        const unsubscribe = this.runtime.state.subscribe(check);
        const unsubscribeCredentials = scope.session_id
          ? credentials.subscribe('session', scope.session_id, check)
          : scope.relay_id
            ? credentials.subscribe('relay', scope.relay_id, check)
            : () => {};
        // Capture only after subscription: no commit can fall between baseline and watch.
        previous = canonicalCommand(json([snapshot(), authorize().deadline]));
        return () => {
          unsubscribe();
          unsubscribeCredentials();
          wake = undefined;
          this.runtime.deadlines.cancel(key);
        };
      },
      update: (payload) => {
        authorize();
        if (scope.topic === 'receiver') {
          const update = receiverUpdate.parse(payload);
          if (update.generation !== scope.receiver_generation)
            throw new ForbiddenError('Receiver generation changed');
          presence.update(handle.attachment.id, json({ ...update, observed_at: new Date().toISOString() }));
        } else if (scope.topic === 'session' && scope.native_instance_id) {
          const report = z
            .object({ active_claim_ids: z.array(z.string().uuid()).max(1024) })
            .strict()
            .parse(payload);
          presence.update(
            handle.attachment.id,
            json({ active_claim_ids: [...new Set(report.active_claim_ids)].sort() }),
          );
        } else if (scope.topic === 'relay')
          presence.update(handle.attachment.id, json(relayUpdate.parse(payload)));
        else throw new ForbiddenError('State topic does not accept volatile updates');
      },
      detach: () => {
        stopped = true;
        this.runtime.deadlines.cancel(key);
        handle.detach();
      },
    };
  }
}
