import { wsPublisher } from '../ws/publisher.js';

const FALLBACK_MS = 2000;

/**
 * Grid period of a proven-idle relay credential. Work events wake waiters at
 * once; the grid only notices time-based eligibility (retry, lease and expiry
 * times), which no event announces. 2 s cost about 8 relay proofs per second
 * for an idle fleet of 17 relays (2026-10-23).
 */
export const relayLongPollConfig = { gridMs: 10_000 };

// Host/daemon/address telemetry is not work. Fleet heartbeats otherwise wake every relay and recreate the SQL polling
// amplification.
function wakesRelays(type: string): boolean {
  return type === 'agent_messaging.message.changed' || /^(settings\.|engine\.|agent_messaging\.state\.)/.test(type);
}

// Admission changes wake nobody, but no waiter may join a shared check that started before one of them.
function invalidatesSharedIdle(type: string): boolean {
  return wakesRelays(type) || type === 'agent_messaging.relay.changed' || /^host\.(updated|deleted|pruned)$/.test(type);
}

let shareRevision = 0;
wsPublisher.subscribe(({ type }) => {
  if (invalidatesSharedIdle(type)) shareRevision++;
});

const inFlight = new Map<string, { revision: number; idle: Promise<boolean> }>();

/**
 * A daemon relay parks one waiter per execution slot on the same credential, and every fallback repeated the identical
 * admission and pending-work check. Parked waiters of one credential now wake on one shared grid timer and join the
 * check still in flight. A settled answer is never reused, and nothing started before an admission or wake event is
 * joined after it. True means proven idle; false or an error sends the caller down its own fenced claim.
 */
function sharedIdle(key: string, check: () => Promise<boolean>): Promise<boolean> {
  let entry = inFlight.get(key);
  if (!entry || entry.revision !== shareRevision) {
    const created = { revision: shareRevision, idle: check() };
    inFlight.set(key, created);
    void created.idle
      .finally(() => {
        if (inFlight.get(key) === created) inFlight.delete(key);
      })
      .catch(() => undefined);
    entry = created;
  }
  return entry.idle.catch(() => false);
}

/** Milliseconds until the next grid point of `key`, in (0, gridMs]; the phase is stable per credential. */
export function relayGridDelay(key: string, now: number): number {
  const period = relayLongPollConfig.gridMs;
  let phase = 0;
  for (let i = 0; i < key.length; i++) phase = (phase * 31 + key.charCodeAt(i)) % period;
  return (phase - (now % period) + period) % period || period;
}

const gridTicks = new Map<string, { waiters: Set<() => void>; timer: ReturnType<typeof setTimeout> }>();

/** Parks `release` on the key's next grid point. One timer releases every waiter of the key in the same tick. */
function onGrid(key: string, release: () => void): () => void {
  let tick = gridTicks.get(key);
  if (!tick) {
    const waiters = new Set<() => void>();
    const created = {
      waiters,
      timer: setTimeout(() => {
        if (gridTicks.get(key) === created) gridTicks.delete(key);
        for (const waiter of [...waiters]) waiter();
      }, relayGridDelay(key, Date.now())),
    };
    gridTicks.set(key, created);
    tick = created;
  }
  const parked = tick;
  parked.waiters.add(release);
  return () => {
    parked.waiters.delete(release);
    if (parked.waiters.size === 0 && gridTicks.get(key) === parked) {
      clearTimeout(parked.timer);
      gridTicks.delete(key);
    }
  };
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
    // A request's first check is always its own, so it never inherits another waiter's admission.
    let first = true;
    while (true) {
      const observed = revision;
      const proven = idle && !first ? await sharedIdle(idle.key, idle.check) : false;
      first = false;
      const result = proven ? null : await poll();
      if (result || Date.now() >= deadline || disconnected || gone()) return result;
      // A send may have committed while the empty query was in flight.
      if (revision !== observed) continue;
      await new Promise<void>((resolve) => {
        let cancel = () => {};
        const done = () => {
          cancel();
          wake = undefined;
          resolve();
        };
        const remaining = Math.max(0, deadline - Date.now());
        if (idle && relayGridDelay(idle.key, Date.now()) < remaining) {
          cancel = onGrid(idle.key, done);
        } else {
          const timer = setTimeout(done, Math.min(FALLBACK_MS, remaining));
          cancel = () => clearTimeout(timer);
        }
        wake = done;
      });
      if (Date.now() >= deadline || disconnected || gone()) return null;
    }
  } finally {
    unsubscribe();
    connection?.off('close', disconnect);
  }
}
