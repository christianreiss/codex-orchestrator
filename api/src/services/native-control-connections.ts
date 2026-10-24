import type { Database } from '../db/client.js';
import type { NativeControl } from './native-stop.js';

interface Entry {
  sessionId: string;
  instanceId: string;
  generation: number | null;
  alive: () => boolean;
  wake: () => void;
}

/** Transport evidence only. Durable stop admission still locks the current binding. */
export class NativeControlConnections {
  private readonly entries = new Set<Entry>();

  watch(sessionId: string, instanceId: string, alive: () => boolean, wake: () => void) {
    const entry: Entry = { sessionId, instanceId, generation: null, alive, wake };
    this.entries.add(entry);
    return {
      bind: (generation: number) => { entry.generation = generation; },
      close: () => { this.entries.delete(entry); },
    };
  }

  connected(row: NativeControl): boolean {
    for (const entry of this.entries) {
      if (entry.sessionId === row.sessionId && entry.instanceId === row.instanceId &&
        entry.generation === row.bindingGeneration && entry.alive()) return true;
    }
    return false;
  }

  changed(sessionId: string): void {
    for (const entry of this.entries) if (entry.sessionId === sessionId) entry.wake();
  }
}

const registries = new WeakMap<Database, NativeControlConnections>();
export function nativeControlConnections(db: Database): NativeControlConnections {
  let registry = registries.get(db);
  if (!registry) { registry = new NativeControlConnections(); registries.set(db, registry); }
  return registry;
}
