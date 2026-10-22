import { wsPublisher } from '../ws/publisher.js';

/** Events only hint that work changed; every retry rechecks durable admission. */
export async function relayLongPoll<T>(
  poll: () => Promise<T | null>,
  deadline: number,
  gone: () => boolean,
  connection?: {
    on(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
  },
): Promise<T | null> {
  let revision = 0;
  let disconnected = false;
  let wake: (() => void) | undefined;
  const disconnect = () => {
    disconnected = true;
    wake?.();
  };
  connection?.on('close', disconnect);
  const unsubscribe = wsPublisher.subscribe(({ type }) => {
    // Host/daemon/address telemetry is not work. Fleet heartbeats otherwise
    // wake every relay and recreate the SQL polling amplification.
    if (
      type !== 'agent_messaging.message.changed' &&
      !/^(settings\.|engine\.|agent_messaging\.state\.)/.test(type)
    )
      return;
    revision++;
    wake?.();
  });
  try {
    while (true) {
      const observed = revision;
      const result = await poll();
      if (result || Date.now() >= deadline || disconnected || gone()) return result;
      // A send may have committed while the empty query was in flight.
      if (revision !== observed) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            wake = undefined;
            resolve();
          },
          Math.min(2000, Math.max(0, deadline - Date.now())),
        );
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
      if (Date.now() >= deadline || disconnected || gone()) return null;
    }
  } finally {
    unsubscribe();
    connection?.off('close', disconnect);
  }
}
