import { OWNED_TABLE_NAMES } from '../control-plane/state/catalog.js';
import type { OwnerRuntime } from '../control-plane/state/runtime.js';
import { randomUUID } from 'node:crypto';
import type { WsEvent, WsEventType } from './events.js';
import { nowIso } from '../util/timestamp.js';

type Listener = (e: WsEvent) => void;

/**
 * In-process event bus. The Fastify WS handler subscribes to it on connection
 * and writes events out to connected clients. Services in any worktree publish
 * via the singleton imported from this module.
 */
class Publisher {
  private readonly epoch = randomUUID();
  private sequence = 0n;

  cursor(): { epoch: string; sequence: string } {
    return { epoch: this.epoch, sequence: this.sequence.toString() };
  }
  private listeners = new Set<Listener>();
  private backlog: WsEvent[] = [];
  private backlogCap = 1000;

  publish<P>(type: WsEventType | string, payload: P): void {
    const event: WsEvent<P> = { type, payload, ts: nowIso(), epoch: this.epoch, sequence: (++this.sequence).toString() };
    this.backlog.push(event);
    if (this.backlog.length > this.backlogCap) this.backlog.shift();
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recent(limit = 50): WsEvent[] {
    return this.backlog.slice(-limit);
  }

  setBacklogCap(cap: number): void {
    this.backlogCap = Math.max(1, cap);
  }
}

export const wsPublisher = new Publisher();

/** Publish committed metadata changes only; transport activity never enters this stream. */
export function publishOwnerStateChanges(runtime: OwnerRuntime): () => void {
  let previous = runtime.state.snapshot();
  return runtime.state.subscribe((snapshot) => {
    const tables = OWNED_TABLE_NAMES.filter((name) => previous.table(name) !== snapshot.table(name));
    previous = snapshot;
    if (tables.length) wsPublisher.publish('control_state.changed', { tables });
  });
}
