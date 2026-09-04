/**
 * Unit coverage for derived agent presence.
 *
 * This is the pure half, and it is the half worth pinning, because every way it
 * can be wrong is silent. Presence that reads too generous does not throw — it
 * routes a call to an agent that is not there and strands the caller until the
 * message TTL expires a day later. Presence that reads too strict does not
 * throw either — it reclaims a branch lease out from under an agent that was
 * merely quiet.
 *
 * The regression these tests exist for: `readiness` alone reported peers as
 * reachable a month after they died, because for a session that never calls
 * `agent_listen` the column is written once at registration and not again until
 * finish. Every case below therefore fixes a *timestamp* outcome, never a
 * `readiness` one.
 *
 * The DB-backed half — the joins that feed this, and the Director sweep that
 * consumes it — lives in `test/integration/`.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_PRESENCE_FRESH_SECONDS,
  deriveAddressPresence,
  isPresent,
  type PresenceAddress,
  type PresenceSession,
} from '../../../src/services/agent-presence.js';

const FRESH_AFTER = '2026-09-04T12:00:00Z';
const FRESH = '2026-09-04T12:00:30Z';
const STALE = '2026-09-04T11:59:30Z';

function address(over: Partial<PresenceAddress> = {}): PresenceAddress {
  return {
    enabled: 1,
    archivedAt: null,
    readiness: 'resumable',
    currentSessionId: 'session-1',
    lastUpstreamSessionId: null,
    receiveHeartbeatAt: null,
    ...over,
  };
}

function session(over: Partial<PresenceSession> = {}): PresenceSession {
  return { heartbeatAt: FRESH, endedAt: null, ...over };
}

describe('deriveAddressPresence', () => {
  it('reports a heartbeating session as online even though readiness says resumable', () => {
    // The exact shape of an ordinary interactive session: `readiness` was
    // written 'resumable' at registration and never moved, because nothing
    // passed `receive_capable`. Only the heartbeat knows it is alive.
    expect(deriveAddressPresence(address({ readiness: 'resumable' }), session(), FRESH_AFTER)).toBe('online');
  });

  it('promotes to listening only when the address can take a pushed message now', () => {
    expect(deriveAddressPresence(address({ receiveHeartbeatAt: FRESH }), session(), FRESH_AFTER)).toBe('listening');
  });

  it('falls back to online when the receive binding has gone stale under a live session', () => {
    expect(deriveAddressPresence(address({ receiveHeartbeatAt: STALE }), session(), FRESH_AFTER)).toBe('online');
  });

  it('drops a session whose heartbeat stopped, which is the crash path', () => {
    expect(deriveAddressPresence(address(), session({ heartbeatAt: STALE }), FRESH_AFTER)).toBe('offline');
  });

  it('drops a finished session immediately rather than waiting out the window', () => {
    // `finishSession` stamps `last_seen_at` on the address, so anything deriving
    // from that column would call a clean logout "fresh" for a further window.
    // Going through the session is what makes the exit instant.
    expect(deriveAddressPresence(address(), session({ endedAt: FRESH, heartbeatAt: FRESH }), FRESH_AFTER)).toBe('offline');
  });

  it('treats a reaped binding with no session row as gone', () => {
    expect(deriveAddressPresence(address({ currentSessionId: null }), null, FRESH_AFTER)).toBe('offline');
    expect(deriveAddressPresence(address(), undefined, FRESH_AFTER)).toBe('offline');
  });

  it('separates resumable from offline on the upstream session id alone', () => {
    const dead = session({ heartbeatAt: STALE });
    expect(deriveAddressPresence(address({ lastUpstreamSessionId: 'upstream-1' }), dead, FRESH_AFTER)).toBe('resumable');
    expect(deriveAddressPresence(address({ lastUpstreamSessionId: null }), dead, FRESH_AFTER)).toBe('offline');
  });

  it('holds the boundary closed: a heartbeat exactly at the cutoff is stale', () => {
    // The gate is `>`, matching the delivery gate and the live_addresses metric.
    // Pinned because an off-by-one here is invisible until a busy agent flaps.
    expect(deriveAddressPresence(address(), session({ heartbeatAt: FRESH_AFTER }), FRESH_AFTER)).toBe('offline');
  });

  it('reports disabled for every way an address can be switched off', () => {
    expect(deriveAddressPresence(address({ readiness: 'disabled' }), session(), FRESH_AFTER)).toBe('disabled');
    expect(deriveAddressPresence(address({ enabled: 0 }), session(), FRESH_AFTER)).toBe('disabled');
    expect(deriveAddressPresence(address({ archivedAt: FRESH }), session(), FRESH_AFTER)).toBe('disabled');
  });

  it('does not let a live heartbeat resurrect a disabled address', () => {
    expect(
      deriveAddressPresence(address({ enabled: 0, receiveHeartbeatAt: FRESH }), session(), FRESH_AFTER),
    ).toBe('disabled');
  });
});

describe('isPresent', () => {
  it('counts only the two states with a wrapper actually behind them', () => {
    expect(isPresent('listening')).toBe(true);
    expect(isPresent('online')).toBe(true);
  });

  it('excludes resumable, which is a session that ended and could be resumed', () => {
    // Treating this as present is the original bug: it is what let
    // `agent_list(online: true)` return agents last seen a month earlier.
    expect(isPresent('resumable')).toBe(false);
    expect(isPresent('offline')).toBe(false);
    expect(isPresent('disabled')).toBe(false);
  });
});

describe('AGENT_PRESENCE_FRESH_SECONDS', () => {
  it('leaves at least two heartbeat ticks of margin', () => {
    // The wrapper ticks every 15s from its own goroutine. If this default ever
    // drops below ~30s a live agent mid-tool-call starts flapping offline.
    expect(AGENT_PRESENCE_FRESH_SECONDS).toBeGreaterThanOrEqual(30);
  });
});
