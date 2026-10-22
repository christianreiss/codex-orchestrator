import { wsPublisher } from '../ws/publisher.js';

const FALLBACK_MS = 2000;

// Host/daemon/address telemetry is not work. Fleet heartbeats otherwise wake every relay and recreate the SQL polling
// amplification.
function wakesRelays(type: string): boolean {
  return type === 'agent_messaging.message.changed' || /^(settings\.|engine\.|agent_messaging\.state\.)/.test(type);
}

// Process-wide count of those events: a shared idle answer is only reusable while it has not moved.
let wakeRevision = 0;
wsPublisher.subscribe(({ type }) => {
  if (wakesRelays(type)) wakeRevision++;
});

interface IdleCheck {
  revision: number;
  startedAt: number;
  idle: Promise<boolean>;
}
const idleChecks = new Map<string, IdleCheck>();

/**
 * A daemon relay parks one waiter per execution slot on the same credential, and every fallback repeated the identical
 * admission and pending-work check. Waiters share only a proven-idle answer, only from the same wake revision and only
 * within one fallback period, so a change without an event is still seen within one period. Work or an error sends
 * every waiter down its own fenced claim. Returns when the shared check started, or null when the caller must poll.
 */
async function sharedIdle(key: string, check: () => Promise<boolean>): Promise<number | null> {
  const now = Date.now();
  let current = idleChecks.get(key);
  if (!current || current.revision !== wakeRevision || now - current.startedAt >= FALLBACK_MS) {
    for (const [stale, entry] of idleChecks) if (now - entry.startedAt >= FALLBACK_MS) idleChecks.delete(stale);
    const entry: IdleCheck = { revision: wakeRevision, startedAt: now, idle: check() };
    entry.idle.catch(() => {
      if (idleChecks.get(key) === entry) idleChecks.delete(key);
    });
    idleChecks.set(key, entry);
    current = entry;
  }
  try {
    return (await current.idle) ? current.startedAt : null;
  } catch {
    return null;
  }
}

/** Events only hint that work changed; every retry rechecks durable admission. */
export async function relayLongPoll<T>(
  poll: () => Promise<T | null>,
  deadline: number,
  gone: () => boolean,
  connection?: {
    on(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
  },
  idle?: { key: string; check: () => Promise<boolean> },
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
    if (!wakesRelays(type)) return;
    revision++;
    wake?.();
  });
  try {
    while (true) {
      const observed = revision;
      const idleSince = idle ? await sharedIdle(idle.key, idle.check) : null;
      const result = idleSince === null ? await poll() : null;
      if (result || Date.now() >= deadline || disconnected || gone()) return result;
      // A send may have committed while the empty query was in flight.
      if (revision !== observed) continue;
      // A shared answer keeps its own fallback grid, so siblings recheck together instead of drifting apart.
      const wait =
        idleSince !== null && idleSince + FALLBACK_MS > Date.now() ? idleSince + FALLBACK_MS - Date.now() : FALLBACK_MS;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            wake = undefined;
            resolve();
          },
          Math.max(0, Math.min(wait, deadline - Date.now())),
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
