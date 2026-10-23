import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';

/**
 * Liveness kept in RAM, persisted in batches.
 *
 * A heartbeat that changes nothing but timestamps used to be a locked
 * transaction of 10–15 statements that rewrote the same rows every 15 s per
 * session (2026-10-23: ~3 beats/s, the largest remaining statement family).
 * Such beats are now recorded here and written every `intervalMs`, one
 * autocommit UPDATE per row. A multi-row UPDATE deadlocked against
 * transactions that lock several sessions (production, 2026-10-23); a
 * single-row statement holds no other lock while it waits, so it cannot.
 *
 * Readers keep reading the same columns. The persisted values lag by at most
 * one interval, far inside the 45–60 s freshness windows. Every write is
 * monotonic (GREATEST, which leaves NULL alone) and guarded by the receiver
 * generation, the address binding, relay generation and ended_at, so a beat
 * flushed after a state change can neither regress nor resurrect anything.
 * A beat that would change state, or arrives while the stored heartbeat is
 * no longer fresh, keeps the existing transactional path.
 */

interface PortalBeat {
  heartbeatAt: string;
  bridgeExpiresAt: string;
}
interface ReceiverBeat {
  generation: string;
  heartbeatAt: string;
  claimGate: unknown;
  addressId: string | null;
}
interface RelayBeat {
  generation: number;
  heartbeatAt: string;
  tokenExpiresAt: string;
}

export interface LivenessLedgerStats {
  portalFast: number;
  receiverFast: number;
  relayFast: number;
  flushes: number;
  flushedRows: number;
  flushErrors: number;
}


function later(a: string | undefined, b: string): string {
  return a !== undefined && a > b ? a : b;
}

/** `CASE id WHEN … THEN … ELSE <column> END` over the batch. */
function caseOf(rows: Array<[string | number, SQL]>, otherwise: SQL): SQL {
  return sql`CASE id ${sql.join(rows.map(([id, value]) => sql`WHEN ${id} THEN ${value}`), sql` `)} ELSE ${otherwise} END`;
}

export class LivenessLedger {
  private portal = new Map<string, PortalBeat>();
  private receivers = new Map<string, ReceiverBeat>();
  private relays = new Map<string, RelayBeat>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private readonly counters: LivenessLedgerStats = { portalFast: 0, receiverFast: 0, relayFast: 0, flushes: 0, flushedRows: 0, flushErrors: 0 };

  constructor(
    private readonly db: Database,
    private readonly intervalMs = 5000,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /** Beats are deferred only while the flush timer runs (the API process); otherwise they stay transactional. */
  get active(): boolean {
    return this.timer !== undefined;
  }

  start() {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  stats(): LivenessLedgerStats & { pending: number } {
    return { ...this.counters, pending: this.portal.size + this.receivers.size + this.relays.size };
  }

  /** Latest heartbeat held for a session, newer than the stored one until flushed. */
  portalHeartbeat(sessionId: string): string | undefined {
    return this.portal.get(sessionId)?.heartbeatAt;
  }

  receiverHeartbeat(sessionId: string, generation: string): string | undefined {
    const beat = this.receivers.get(sessionId);
    return beat?.generation === generation ? beat.heartbeatAt : undefined;
  }

  notePortal(sessionId: string, heartbeatAt: string, bridgeExpiresAt: string) {
    const previous = this.portal.get(sessionId);
    this.portal.set(sessionId, {
      heartbeatAt: later(previous?.heartbeatAt, heartbeatAt),
      bridgeExpiresAt: later(previous?.bridgeExpiresAt, bridgeExpiresAt),
    });
    this.counters.portalFast++;
  }

  noteReceiver(sessionId: string, beat: ReceiverBeat) {
    const previous = this.receivers.get(sessionId);
    this.receivers.set(sessionId, previous?.generation === beat.generation
      ? { ...beat, heartbeatAt: later(previous.heartbeatAt, beat.heartbeatAt) }
      : beat);
    this.counters.receiverFast++;
  }

  noteRelay(relayId: string, beat: RelayBeat) {
    const previous = this.relays.get(relayId);
    this.relays.set(relayId, previous?.generation === beat.generation
      ? { generation: beat.generation, heartbeatAt: later(previous.heartbeatAt, beat.heartbeatAt), tokenExpiresAt: later(previous.tokenExpiresAt, beat.tokenExpiresAt) }
      : beat);
    this.counters.relayFast++;
  }

  /** Writes everything held so far; a running flush is joined, never overlapped. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async flushOnce() {
    const portal = [...this.portal];
    const receivers = [...this.receivers];
    const relays = [...this.relays];
    this.portal.clear();
    this.receivers.clear();
    this.relays.clear();
    if (!portal.length && !receivers.length && !relays.length) return;
    this.counters.flushes++;
    // A failed row is kept for the next flush unless a newer beat replaced it.
    const each = async <B>(rows: Array<[string, B]>, held: Map<string, B>, write: (rows: Array<[string, B]>) => Promise<void>) => {
      for (const row of rows) {
        try {
          await write([row]);
          this.counters.flushedRows++;
        } catch (err) {
          if (!held.has(row[0])) held.set(row[0], row[1]);
          this.counters.flushErrors++;
          this.onError(err);
        }
      }
    };
    await each(portal, this.portal, (rows) => this.writePortal(rows));
    await each(receivers, this.receivers, (rows) => this.writeReceivers(rows));
    await each(relays, this.relays, (rows) => this.writeRelays(rows));
  }

  private async writePortal(rows: Array<[string, PortalBeat]>) {
    const ids = rows.map(([id]) => id);
    await this.db.execute(sql`UPDATE agent_sessions SET
      heartbeat_at = ${caseOf(rows.map(([id, b]) => [id, sql`GREATEST(heartbeat_at, ${b.heartbeatAt})`]), sql`heartbeat_at`)},
      bridge_expires_at = ${caseOf(rows.map(([id, b]) => [id, sql`GREATEST(bridge_expires_at, ${b.bridgeExpiresAt})`]), sql`bridge_expires_at`)}
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND ended_at IS NULL`);
  }

  private async writeReceivers(rows: Array<[string, ReceiverBeat]>) {
    const ids = rows.map(([id]) => id);
    const current = (b: ReceiverBeat) => sql`JSON_UNQUOTE(JSON_EXTRACT(receiver, '$.generation')) = ${b.generation}`;
    // The receiver JSON carries its own heartbeat and claim-gate telemetry;
    // the columns mirror it only where they are already set (GREATEST keeps NULL).
    await this.db.execute(sql`UPDATE agent_sessions SET
      receiver = ${caseOf(rows.map(([id, b]) => {
        const beat = sql`JSON_SET(receiver, '$.heartbeat_at', GREATEST(JSON_UNQUOTE(JSON_EXTRACT(receiver, '$.heartbeat_at')), ${b.heartbeatAt}))`;
        // Same shape as the transactional beat: telemetry present, or the key absent.
        const gated = b.claimGate === undefined
          ? sql`JSON_REMOVE(${beat}, '$.claim_gate')`
          : sql`JSON_SET(${beat}, '$.claim_gate', CAST(${JSON.stringify(b.claimGate)} AS JSON))`;
        return [id, sql`IF(${current(b)}, ${gated}, receiver)`];
      }), sql`receiver`)},
      receive_heartbeat_at = ${caseOf(rows.map(([id, b]) => [id, sql`IF(${current(b)}, GREATEST(receive_heartbeat_at, ${b.heartbeatAt}), receive_heartbeat_at)`]), sql`receive_heartbeat_at`)},
      relay_heartbeat_at = ${caseOf(rows.map(([id, b]) => [id, sql`IF(${current(b)}, GREATEST(relay_heartbeat_at, ${b.heartbeatAt}), relay_heartbeat_at)`]), sql`relay_heartbeat_at`)}
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND ended_at IS NULL`);
    const bound = rows.filter(([, b]) => b.addressId);
    if (!bound.length) return;
    await this.db.execute(sql`UPDATE agent_bus_addresses SET
      receive_heartbeat_at = CASE ${sql.join(bound.map(([sessionId, b]) => sql`WHEN id = ${b.addressId} AND current_session_id = ${sessionId} THEN GREATEST(receive_heartbeat_at, ${b.heartbeatAt})`), sql` `)} ELSE receive_heartbeat_at END
      WHERE id IN (${sql.join(bound.map(([, b]) => sql`${b.addressId}`), sql`, `)})`);
  }

  private async writeRelays(rows: Array<[string, RelayBeat]>) {
    const ids = rows.map(([id]) => id);
    const match = (id: string, b: RelayBeat) => sql`id = ${id} AND generation = ${b.generation}`;
    await this.db.execute(sql`UPDATE agent_bus_relays SET
      heartbeat_at = CASE ${sql.join(rows.map(([id, b]) => sql`WHEN ${match(id, b)} THEN GREATEST(heartbeat_at, ${b.heartbeatAt})`), sql` `)} ELSE heartbeat_at END,
      token_expires_at = CASE ${sql.join(rows.map(([id, b]) => sql`WHEN ${match(id, b)} THEN GREATEST(token_expires_at, ${b.tokenExpiresAt})`), sql` `)} ELSE token_expires_at END
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND token_hash IS NOT NULL`);
  }
}

/**
 * Persisted values lag by at most this much behind the newest beat. With
 * beats every 15–20 s a row is written about once per interval, and the
 * stored value stays under 30 s old, inside the 45 s freshness windows.
 */
export const LIVENESS_FLUSH_MS = 10_000;

let shared: LivenessLedger | undefined;

/** The API process installs its started ledger at boot. */
export function setLivenessLedger(ledger: LivenessLedger | undefined) {
  shared = ledger;
}

/**
 * One ledger per process, shared so flush order and counters are global.
 * Without an installed (started) ledger, e.g. in tests or CLI tools, callers
 * get an inactive one and keep every beat transactional.
 */
export function livenessLedger(db: Database): LivenessLedger {
  if (!shared) shared = new LivenessLedger(db, 0);
  return shared;
}
