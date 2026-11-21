import { z } from 'zod';
import type { Json } from './commands.js';

export const CONTROL_STATE_CAPABILITY = 'control_state_v1';
export const COMMUNICATOR_STATE_LIVENESS_CAPABILITY = 'communicator_state_liveness_v1';
export const stateScopeSchema = z
  .object({
    topic: z.enum(['session', 'receiver', 'relay', 'daemon', 'sync', 'provider']),
    session_id: z.guid().optional(),
    binding_generation: z.number().int().positive().optional(),
    receiver_generation: z.string().min(1).max(100).optional(),
    native_instance_id: z.guid().optional(),
    relay_id: z.guid().optional(),
    provider_session_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    engine: z.enum(['codex', 'claude', 'grok', 'kimi']).optional(),
  })
  .strict();
export const stateFrameSchema = z
  .object({
    type: z.enum([
      'state_open',
      'state_snapshot',
      'state_delta',
      'state_ack',
      'state_update',
      'state_command',
      'state_receipt',
      'state_close',
      'state_ping',
      'state_pong',
    ]),
    protocol: z.literal(1),
    stream_id: z.guid(),
    owner_epoch: z.guid().optional(),
    revision: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(20)
      .optional(),
    scope: stateScopeSchema.optional(),
    auth: z
      .object({
        bridge_token: z.string().min(1).max(4096).optional(),
        relay_token: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .optional(),
    command_id: z.guid().optional(),
    payload: z.unknown().optional(),
    code: z.string().max(100).optional(),
  })
  .strict();
export type StateScope = z.infer<typeof stateScopeSchema>;
export type StateFrame = z.infer<typeof stateFrameSchema>;

export interface StateProjection {
  /** All methods read the current owner's RAM. No SQL, even after reconnect. */
  snapshot(): Json;
  authorize(): { deadline: number | null };
  subscribe(changed: (change?: 'authorization') => void): () => void;
  update(payload: unknown): void | Promise<void>;
  detach(): void | Promise<void>;
}
export interface StateProvider {
  epoch: string;
  assertOwner(): void;
  open(scope: StateScope, auth: NonNullable<StateFrame['auth']>): Promise<StateProjection>;
}
interface Stream {
  id: string;
  projection?: StateProjection;
  unsubscribe?: () => void;
  revision: bigint;
  applied: bigint;
  lastPong: number;
  deadline?: ReturnType<typeof setTimeout>;
  authorizationRefresh: boolean;
  lastServerTime?: number;
  refreshRetry?: ReturnType<typeof setTimeout>;
  pending?: 'state_delta' | 'state_ping';
  initialized: boolean;
}

/** Multiplexed state on one authenticated communicator, with exact stream cleanup. */
export class ControlStateStreams {
  private readonly streams = new Map<string, Stream>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private delegatedLiveness = false;
  constructor(
    private readonly provider: StateProvider,
    private readonly transport: {
      send(frame: StateFrame): void;
      bufferedBytes(): number;
      error(error: unknown): void;
    },
    private readonly options = {
      maxStreams: 512,
      maxBufferedBytes: 1024 * 1024,
      pingMs: 15_000,
      timeoutMs: 45_000,
    },
  ) {}

  /** Only the authenticated communicator capability handshake may delegate this proof. */
  delegateTransportLiveness(): void {
    this.provider.assertOwner();
    this.delegatedLiveness = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async receive(input: unknown): Promise<void> {
    const frame = stateFrameSchema.parse(input);
    if (this.closed) return;
    this.provider.assertOwner();
    if (frame.type === 'state_open') {
      await this.open(frame);
      return;
    }
    const stream = this.streams.get(frame.stream_id);
    if (!stream) return;
    // A local attachment may close before its asynchronous admission learns the epoch.
    if (frame.type === 'state_close' && !stream.projection && frame.owner_epoch === undefined) {
      this.remove(stream, 'client_closed', false);
      return;
    }
    if (frame.owner_epoch !== this.provider.epoch) return;
    if (frame.type === 'state_close') {
      this.remove(stream, 'client_closed', false);
      return;
    }
    if (!stream.projection) return;
    try {
      stream.projection.authorize();
      if (frame.type === 'state_pong') stream.lastPong = Date.now();
      else if (frame.type === 'state_ack') {
        const applied = BigInt(frame.revision ?? '-1');
        if (applied < stream.applied || applied > stream.revision)
          throw new Error('Invalid state acknowledgment');
        stream.applied = applied;
      } else if (frame.type === 'state_update') {
        await stream.projection.update(frame.payload);
      } else throw new Error('Unexpected state frame');
    } catch (error) {
      this.transport.error(error);
      this.remove(stream, 'state_rejected');
    }
  }

  close(code = 'owner_unavailable'): void {
    this.closed = true;
    for (const stream of this.streams.values()) this.remove(stream, code);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  size(): number {
    return this.streams.size;
  }

  private async open(frame: StateFrame): Promise<void> {
    if (!frame.scope) throw new Error('State scope required');
    if (this.streams.has(frame.stream_id)) throw new Error('State stream ID already in use');
    if (this.streams.size >= this.options.maxStreams) throw new Error('State stream limit');
    const stream: Stream = {
      id: frame.stream_id,
      revision: 0n,
      applied: 0n,
      lastPong: Date.now(),
      authorizationRefresh: typeof frame.payload === 'object' && frame.payload !== null &&
        'authorization_refresh' in frame.payload && frame.payload.authorization_refresh === 1,
      initialized: false,
    };
    this.streams.set(stream.id, stream);
    try {
      const projection = await this.provider.open(frame.scope, frame.auth ?? {});
      if (this.closed || this.streams.get(stream.id) !== stream) {
        await projection.detach();
        return;
      }
      this.provider.assertOwner();
      stream.projection = projection;
      // Install first, then capture synchronously. Changes coalesce into a later delta.
      stream.unsubscribe = projection.subscribe((change) => this.changed(stream, change));
      this.sendState(stream, 'state_snapshot');
      stream.initialized = true;
      if (!this.delegatedLiveness && !this.timer && this.streams.size) {
        this.timer = setInterval(() => this.ping(), this.options.pingMs);
        this.timer.unref();
      }
    } catch (error) {
      this.transport.error(error);
      this.remove(stream, 'state_unavailable');
    }
  }
  private changed(stream: Stream, change?: 'authorization'): void {
    if (this.streams.get(stream.id) !== stream) return;
    const type = change === 'authorization' && stream.authorizationRefresh ? 'state_ping' : 'state_delta';
    if (stream.pending) {
      if (type === 'state_delta') stream.pending = type;
      return;
    }
    stream.pending = type;
    queueMicrotask(() => {
      const pending = stream.pending!;
      stream.pending = undefined;
      if (!stream.initialized || this.streams.get(stream.id) !== stream) return;
      try {
        this.sendState(stream, pending);
      } catch (error) {
        this.transport.error(error);
        this.remove(stream, 'state_unavailable');
      }
    });
  }
  private sendState(stream: Stream, type: 'state_snapshot' | 'state_delta' | 'state_ping'): void {
    this.provider.assertOwner();
    const projection = stream.projection!;
    const { deadline } = projection.authorize();
    const now = Date.now();
    if (deadline !== null && deadline <= now) throw new Error('State authorization expired');
    // Only a full revision can switch to unrestricted lifetime. For compact
    // refreshes server_time is the replay fence within the same business revision.
    if (type === 'state_ping' && deadline === null) type = 'state_delta';
    if (type === 'state_ping' && stream.lastServerTime !== undefined) {
      if (now < stream.lastServerTime) throw new Error('State authorization clock moved backwards');
      if (now === stream.lastServerTime) {
        if (!stream.refreshRetry) {
          stream.refreshRetry = setTimeout(() => {
            stream.refreshRetry = undefined;
            this.changed(stream, 'authorization');
          }, 1);
          stream.refreshRetry.unref();
        }
        return;
      }
    }
    clearTimeout(stream.refreshRetry);
    stream.refreshRetry = undefined;
    stream.lastServerTime = now;
    clearTimeout(stream.deadline);
    if (deadline !== null) {
      stream.deadline = setTimeout(
        () => {
          try {
            this.sendState(stream, stream.authorizationRefresh ? 'state_ping' : 'state_delta');
          } catch (error) {
            this.transport.error(error);
            this.remove(stream, 'authorization_expired');
          }
        },
        Math.min(2_147_483_647, deadline - Date.now()),
      );
      stream.deadline.unref();
    }
    const snapshot = type === 'state_ping' ? {} : projection.snapshot();
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot))
      throw new Error('State snapshot must be an object');
    const payload = {
      ...snapshot,
      ownership_mode: 'connection',
      server_time: new Date(now).toISOString(),
      authorization_deadline: deadline === null ? null : new Date(deadline).toISOString(),
    };
    if (type !== 'state_ping') stream.revision++;
    this.send(stream, {
      type,
      protocol: 1,
      stream_id: stream.id,
      owner_epoch: this.provider.epoch,
      revision: stream.revision.toString(),
      payload,
    });
  }
  private send(stream: Stream, frame: StateFrame): void {
    if (this.transport.bufferedBytes() > this.options.maxBufferedBytes) {
      this.remove(stream, 'resync_required');
      return;
    }
    this.transport.send(frame);
  }
  private ping(): void {
    try {
      this.provider.assertOwner();
    } catch {
      this.close();
      return;
    }
    for (const stream of this.streams.values()) {
      if (!stream.initialized) continue;
      if (Date.now() - stream.lastPong >= this.options.timeoutMs) {
        this.remove(stream, 'transport_timeout');
        continue;
      }
      try {
        this.send(stream, {
          type: 'state_ping',
          protocol: 1,
          stream_id: stream.id,
          owner_epoch: this.provider.epoch,
        });
      } catch (error) {
        this.transport.error(error);
        this.remove(stream, 'transport_lost', false);
      }
    }
  }
  private remove(stream: Stream, code: string, notify = true): void {
    if (this.streams.get(stream.id) !== stream) return;
    this.streams.delete(stream.id);
    clearTimeout(stream.deadline);
    clearTimeout(stream.refreshRetry);
    stream.unsubscribe?.();
    if (notify) {
      try {
        this.transport.send({
          type: 'state_close',
          protocol: 1,
          stream_id: stream.id,
          owner_epoch: this.provider.epoch,
          code,
        });
      } catch {
        /* disconnected peers recover from a fresh snapshot */
      }
    }
    try {
      Promise.resolve(stream.projection?.detach()).catch(this.transport.error);
    } catch (error) {
      this.transport.error(error);
    }
    if (!this.streams.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
