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
    const event: WsEvent<P> = {
      type,
      payload,
      ts: nowIso(),
      epoch: this.epoch,
      sequence: (++this.sequence).toString(),
    };
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
  return runtime.state.subscribe((snapshot, persistence) => {
    const before = previous;
    previous = snapshot;
    if (persistence === 'volatile') return;
    const tables = OWNED_TABLE_NAMES.filter((name) => {
      if (before.table(name) === snapshot.table(name)) return false;
      if (name !== 'versions') return true;
      const old = new Map(before.settings.all().map((row) => [row.name, row.version]));
      const current = new Map(snapshot.settings.all().map((row) => [row.name, row.version]));
      return [...new Set([...old.keys(), ...current.keys()])].some(
        (key) => !key.startsWith('owner_') && old.get(key) !== current.get(key),
      );
    });
    if (tables.length) wsPublisher.publish('control_state.changed', { tables });
  });
}
