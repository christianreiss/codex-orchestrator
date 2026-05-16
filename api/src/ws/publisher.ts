import type { WsEvent, WsEventType } from './events.js';
import { nowIso } from '../util/timestamp.js';

type Listener = (e: WsEvent) => void;

/**
 * In-process event bus. The Fastify WS handler subscribes to it on connection
 * and writes events out to connected clients. Services in any worktree publish
 * via the singleton imported from this module.
 */
class Publisher {
  private listeners = new Set<Listener>();
  private backlog: WsEvent[] = [];
  private backlogCap = 1000;

  publish<P>(type: WsEventType | string, payload: P): void {
    const event: WsEvent<P> = { type, payload, ts: nowIso() };
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
