import { createHash } from 'node:crypto';
import { ApiError, ConflictError } from '../http/errors.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Revision {
  epoch: string;
  sequence: bigint;
}
export interface CommandReceipt {
  principal: string;
  id: string;
  kind: string;
  digest: string;
  revision: Revision;
  result: Json;
  replayClass?: 'internal' | 'external' | 'legacy';
  resultState?: 'available' | 'expired';
}
export interface OutboxIntent {
  id: string;
  kind: string;
  target: string;
  payload: Json;
  availableAt: string;
}
export interface CommandPersistence<Tx> {
  /** Reserve before domain DML. A duplicate rolls back without executing it. */
  reserve?(tx: Tx, receipt: CommandReceipt): Promise<void>;
  receipt(principal: string, id: string): Promise<CommandReceipt | undefined>;
  transaction(run: (tx: Tx) => Promise<void>): Promise<void>;
  record(tx: Tx, receipt: CommandReceipt, outbox: readonly OutboxIntent[]): Promise<void>;
}
export interface PreparedCommand<Tx, Prepared> {
  persistence?: 'volatile' | 'durable';
  state?: Prepared;
  result: Json | (() => Json);
  /** May finalize generated database IDs, but must return validated state before COMMIT. */
  persist(tx: Tx): Promise<Prepared | void>;
  outbox?: readonly OutboxIntent[];
}
export interface Command<Snapshot, Tx, Prepared> {
  principal: string;
  id: string;
  kind: string;
  payload: Json;
  replayClass?: 'internal' | 'external';
  /** Must use current authority, including when returning a stored result. */
  authorize(snapshot: Snapshot): void;
  /** Replays still require current credentials, without the already-mutated target. */
  authorizeReplay?(snapshot: Snapshot): void;
  prepare(
    snapshot: Snapshot,
    revision: Revision,
  ): PreparedCommand<Tx, Prepared> | Promise<PreparedCommand<Tx, Prepared>>;
}
export interface CommandState<Snapshot, Prepared> {
  snapshot(): Snapshot;
  revision(): Revision;
  /** Validate publication before persistence; publish must be synchronous. */
  validate(prepared: Prepared, revision: Revision): void;
  publish(prepared: Prepared, persistence?: 'volatile' | 'durable'): void;
}

export class CommitUncertainError extends Error {
  constructor(cause: unknown) {
    super('Commit outcome is unknown; owner reconstruction required', { cause });
  }
}
export class ReceiptAlreadyExistsError extends Error {}
export class CommandConflictError extends ConflictError {
  constructor(message: string) {
    super(message, 'command_id_conflict');
  }
}
export class CommandResultExpiredError extends ApiError {
  constructor() {
    super('The command was already committed; its retained result has expired', {
      status: 410,
      code: 'command_result_expired',
    });
  }
}
export class OwnerUnavailableError extends Error {}

/** Canonical JSON rejects values JSON.stringify would silently alter. */
export function canonicalCommand(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Command contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalCommand).join(',') + ']';
  if (
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new TypeError('Command contains a non-JSON value');
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalCommand(value[key]!))
      .join(',') +
    '}'
  );
}

function immutablePayload(value: Json): Json {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutablePayload(child);
    Object.freeze(value);
  }
  return value;
}

/** One linearized mutation path; no timer, polling query or empty transaction. */
export class CommandExecutor<Snapshot, Tx, Prepared> {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private accepting = true;

  constructor(
    private readonly options: {
      state: CommandState<Snapshot, Prepared>;
      persistence: CommandPersistence<Tx>;
      assertOwner(): void;
      loseOwner(error: unknown): void;
      committed(receipt: CommandReceipt, outbox: readonly OutboxIntent[]): void;
      notificationError(error: unknown): void;
      maxPending?: number;
    },
  ) {}

  execute(command: Command<Snapshot, Tx, Prepared>): Promise<Json> {
    if (!this.accepting || this.pending >= (this.options.maxPending ?? 1024))
      return Promise.reject(new OwnerUnavailableError('Command admission unavailable'));
    if (
      !command.principal ||
      command.principal.length > 191 ||
      !command.id ||
      command.id.length > 64 ||
      !command.kind ||
      command.kind.length > 191
    )
      return Promise.reject(new TypeError('Command requires a bounded principal and stable request ID'));
    // Capture the envelope and callbacks before queueing. Payload bytes are
    // detached recursively; callbacks may still close over caller-owned inputs,
    // so reject mutation of the submitted envelope at every authority boundary.
    let digest: string;
    let captured: Command<Snapshot, Tx, Prepared>;
    try {
      const payload = canonicalCommand(command.payload);
      const envelope = Object.freeze({ ...command, payload: immutablePayload(JSON.parse(payload) as Json) });
      const unchanged = () => {
        if (
          command.principal !== envelope.principal ||
          command.id !== envelope.id ||
          command.kind !== envelope.kind ||
          canonicalCommand(command.payload) !== payload
        )
          throw new TypeError('Submitted command envelope changed while queued or executing');
      };
      captured = Object.freeze({
        ...envelope,
        authorize(snapshot: Snapshot) {
          unchanged();
          envelope.authorize(snapshot);
          unchanged();
        },
        authorizeReplay(snapshot: Snapshot) {
          unchanged();
          (envelope.authorizeReplay ?? envelope.authorize)(snapshot);
          unchanged();
        },
      });
      digest = createHash('sha256')
        .update(canonicalCommand({ kind: envelope.kind, payload: envelope.payload }))
        .digest('hex');
    } catch (error) {
      return Promise.reject(error);
    }
    this.pending++;
    const task = this.tail.then(() => this.run(captured, digest));
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task.finally(() => {
      this.pending--;
    });
  }

  async drain(): Promise<void> {
    this.accepting = false;
    await this.tail;
  }
  queued(): number {
    return this.pending;
  }

  private async run(command: Command<Snapshot, Tx, Prepared>, digest: string): Promise<Json> {
    const o = this.options;
    o.assertOwner();
    const snapshot = o.state.snapshot();
    command.authorize(snapshot);
    const existing = o.persistence.reserve
      ? undefined
      : await o.persistence.receipt(command.principal, command.id);
    o.assertOwner();
    // Connection proofs and absolute deadlines can change during receipt I/O.
    command.authorize(snapshot);
    if (existing) {
      if (existing.digest !== digest)
        throw new CommandConflictError('Command ID reused with a different payload');
      if (existing.resultState === 'expired') throw new CommandResultExpiredError();
      return structuredClone(existing.result);
    }
    const previous = o.state.revision();
    const revision = { epoch: previous.epoch, sequence: previous.sequence + 1n };
    let prepared: PreparedCommand<Tx, Prepared>;
    try {
      prepared = await command.prepare(snapshot, revision);
    } catch (error) {
      // A retry can now fail domain validation because its first execution
      // already changed/deleted the target. Only that exceptional path needs
      // a cold receipt lookup before reservation.
      if (o.persistence.reserve) {
        const prior = await o.persistence.receipt(command.principal, command.id);
        o.assertOwner();
        (command.authorizeReplay ?? command.authorize)(snapshot);
        if (prior) {
          if (prior.digest !== digest)
            throw new CommandConflictError('Command ID reused with a different payload');
          if (prior.resultState === 'expired') throw new CommandResultExpiredError();
          return structuredClone(prior.result);
        }
      }
      throw error;
    }
    o.assertOwner();
    command.authorize(snapshot);
    let nextState = prepared.state;
    if (nextState !== undefined) o.state.validate(nextState, revision);
    if (prepared.persistence === 'volatile') {
      if (prepared.outbox?.length) throw new Error('Volatile commands cannot stage durable effects');
      const result = JSON.parse(
        canonicalCommand(typeof prepared.result === 'function' ? prepared.result() : prepared.result),
      ) as Json;
      command.authorize(snapshot);
      o.assertOwner();
      if (nextState !== undefined) o.state.publish(nextState, 'volatile');
      return result;
    }
    const receipt: CommandReceipt = {
      principal: command.principal,
      id: command.id,
      kind: command.kind,
      digest,
      revision,
      result: null,
      replayClass: command.replayClass ?? 'external',
      resultState: 'available',
    };
    let outbox: readonly OutboxIntent[] = [];
    try {
      await o.persistence.transaction(async (tx) => {
        o.assertOwner();
        await o.persistence.reserve?.(tx, receipt);
        nextState = (await prepared.persist(tx)) ?? nextState;
        if (nextState === undefined) throw new Error('Command did not prepare its committed state');
        o.state.validate(nextState, revision);
        // Insert-generated identities may stage effects during persistence.
        // Capture only once the domain writes and their draft are complete.
        outbox = structuredClone(prepared.outbox ?? []);
        receipt.result = JSON.parse(
          canonicalCommand(typeof prepared.result === 'function' ? prepared.result() : prepared.result),
        ) as Json;
        await o.persistence.record(tx, receipt, outbox);
        o.assertOwner();
        // Preparation or storage may wait on cold I/O. Security deadlines and
        // volatile connection proofs must still hold at the commit boundary.
        command.authorize(snapshot);
      });
    } catch (error) {
      if (error instanceof CommitUncertainError) o.loseOwner(error);
      if (error instanceof ReceiptAlreadyExistsError) {
        const prior = await o.persistence.receipt(command.principal, command.id);
        o.assertOwner();
        (command.authorizeReplay ?? command.authorize)(snapshot);
        if (!prior) throw new OwnerUnavailableError('Duplicate receipt could not be reconstructed');
        if (prior.digest !== digest)
          throw new CommandConflictError('Command ID reused with a different payload');
        if (prior.resultState === 'expired') throw new CommandResultExpiredError();
        return structuredClone(prior.result);
      }
      throw error;
    }
    try {
      o.assertOwner();
      o.state.publish(nextState!);
    } catch (error) {
      o.loseOwner(error);
      throw new OwnerUnavailableError('Committed command requires state reconstruction', { cause: error });
    }
    // Effects are durable already. A notification failure must not undo acceptance.
    try {
      o.committed(receipt, outbox);
    } catch (error) {
      o.notificationError(error);
    }
    return structuredClone(receipt.result);
  }
}
