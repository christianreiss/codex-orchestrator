import type { Database } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { NativeStopService } from './native-stop.js';
import { nativeControlConnections } from './native-control-connections.js';

/** One authenticated native process, carried by one local stream and one WS. */
export function openNativeControlStream(options: {
  db: Database;
  sessionId: string;
  instanceId: string;
  alive: () => boolean;
  authenticate: () => Promise<unknown>;
  send: (status: number, payload: unknown) => void;
}) {
  let closed = false, reading = false, dirty = true;
  let previous = '';
  const service = new NativeStopService(options.db);
  // Subscribe before reading: a committed stop during admission schedules a
  // second read, even when the first read observed the preceding state.
  const watch = nativeControlConnections(options.db).watch(options.sessionId, options.instanceId,
    () => !closed && options.alive(), () => { dirty = true; void pump(); });
  const close = () => { closed = true; watch.close(); };
  async function pump() {
    if (reading || closed) return;
    reading = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        await options.authenticate();
        const value = await service.poll(options.sessionId, options.instanceId);
        if (closed) return;
        watch.bind(value.binding_generation);
        const encoded = JSON.stringify(value);
        if (encoded !== previous) { previous = encoded; options.send(200, value); }
      }
    } catch (err) {
      if (!closed) options.send(err instanceof ApiError ? err.status : 500, {
        code: err instanceof ApiError ? err.code : 'native_control_failed',
      });
      close();
    } finally { reading = false; }
  }
  void pump();
  return close;
}
