import { emptyCompanionEventIndex } from './companion-index.js';
import {
  messagingTotalsFromSeed,
  updateMessagingTotals,
  type MessagingTotals,
  type MessagingTotalsDelta,
} from './messaging-totals.js';
import { createHash } from 'node:crypto';
import {
  OWNED_TABLE_NAMES,
  stateColumns,
  stateIndexFields,
  stateKeyFields,
  type OwnedTableName,
  type StateRow,
  type StateSeed,
  type Row,
} from './catalog.js';

export interface OwnerStateLimits {
  readonly rowsPerTable: number;
  readonly totalRows: number;
  readonly metadataBytes: number;
}
export const DEFAULT_OWNER_STATE_LIMITS: OwnerStateLimits = Object.freeze({
  rowsPerTable: 100_000,
  totalRows: 500_000,
  metadataBytes: 256 * 1024 * 1024,
});
export interface StateMetadataUsage {
  readonly rows: number;
  readonly metadataBytes: number;
  readonly tables: Readonly<Record<OwnedTableName, number>>;
}
function metadataSize(value: unknown): number {
  return Buffer.byteLength(
    JSON.stringify(value, (_, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)),
  );
}
const projectedRows = Symbol('internal projected immutable rows');
const projectedSeeds = new WeakSet<object>();
const entityRows = new WeakMap<object, ReadonlyMap<string, RecordRow>>();
const rowSizes = new WeakMap<object, number>();

export interface StateRevision {
  readonly epoch: string;
  readonly sequence: bigint;
}
export interface WireStateRevision {
  readonly epoch: string;
  readonly sequence: string;
}
export function wireStateRevision(revision: StateRevision): WireStateRevision {
  return { epoch: revision.epoch, sequence: revision.sequence.toString(10) };
}
export function sameStateRevision(a: StateRevision, b: StateRevision): boolean {
  return a.epoch === b.epoch && a.sequence === b.sequence;
}
function revision(value: StateRevision): StateRevision {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.epoch) ||
    value.sequence < 0n
  )
    throw new Error('Invalid owner state revision');
  return Object.freeze({ ...value });
}

type RecordRow = Record<string, unknown>;
type Key = string | number | bigint | readonly (string | number | bigint)[];
function keyOf(value: Key): string {
  return JSON.stringify(Array.isArray(value) ? value : [value], (_, x: unknown) =>
    typeof x === 'bigint' ? { bigint: x.toString() } : x,
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function copy<T>(value: T): T {
  return freeze(structuredClone(value));
}
function scalarKey(value: unknown): string {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (value === null || ['string', 'number', 'boolean', 'bigint', 'undefined'].includes(typeof value))
    return `${typeof value}:${String(value)}`;
  throw new Error('State index requires a scalar value');
}

/** A typed row collection, not a SQL query interpreter. Every lookup is owned RAM. */
export class EntityView<K extends OwnedTableName> {
  readonly metadataBytes: number;
  readonly #rows: ReadonlyMap<string, StateRow<K>>;
  readonly #indexes: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  readonly #keys: readonly string[];
  constructor(
    readonly name: K,
    rows: Iterable<StateRow<K> | Row<K>>,
    internalProjection?: symbol,
  ) {
    this.#keys = stateKeyFields(name);
    const stored = new Map<string, StateRow<K>>();
    const columns = new Set(Object.keys(stateColumns(name)));
    if (['agentBusGroups', 'agentBusConferences', 'agentScopes'].includes(name)) columns.add('roomHead');
    if (name === 'agentRoomReads') columns.add('unreadCount');
    if (name === 'coordProjects') columns.add('recentEvents');
    if (name === 'authPayloads') columns.add('canonicalBodyProof');
    if (name === 'agentRoleVersions') columns.add('roleLabel');
    if (name === 'adminUsers') columns.add('credentialDigest');
    if (name === 'coordProjectNotes') {
      columns.add('bodyPreview');
      columns.add('bodyLength');
    }
    if (name === 'coordProjectMemories') {
      columns.add('contentPreview');
      columns.add('contentLength');
    }
    if (name === 'coordProjectFiles') {
      columns.add('sizeBytes');
      columns.add('contentTail');
    }
    if (name === 'companionDevices') columns.add('pushTokenDigest');
    if (name === 'chattySessions') columns.add('eventCursor');
    if (name === 'sharedMemories') {
      columns.add('contentPreview');
      columns.add('highestRevision');
    }
    if (name === 'agentBusConversations') {
      columns.add('lastToASequence');
      columns.add('lastToBSequence');
    }
    if (name === 'agentSessions') {
      columns.add('companionEvents');
      columns.add('taskTitle');
      columns.add('taskTitleNativeId');
      columns.add('taskTitleEventId');
      for (const field of [
        'portalEventCursor',
        'portalAttentionCursor',
        'portalAttentionClearedCursor',
        'portalLastEventType',
        'portalLastEventAt',
      ])
        columns.add(field);
    }
    if (name === 'hosts') {
      columns.add('credentialLookupHash');
      columns.add('authFingerprint');
      columns.add('registrationAt');
    }
    for (const input of rows) {
      if (internalProjection === projectedRows) {
        const row = input as StateRow<K>,
          key = this.keyFor(row);
        if (stored.has(key)) throw new Error(`Duplicate owner state key in ${name}`);
        stored.set(key, row);
        continue;
      }
      const record = input as RecordRow;
      const projected: RecordRow = {};
      for (const field of columns) if (Object.hasOwn(record, field)) projected[field] = record[field];
      if (name === 'agentRoleVersions') projected.roleLabel ??= null;
      if (['agentBusGroups', 'agentBusConferences', 'agentScopes'].includes(name))
        projected.roomHead ??= { eventCount: 0, lastAt: null, actorCounts: {} };
      if (name === 'agentRoomReads') projected.unreadCount = Number(projected.unreadCount ?? 0);
      if (name === 'coordProjects') projected.recentEvents ??= [];
      if (name === 'coordProjectNotes') {
        if (typeof record.body === 'string') {
          projected.bodyPreview = record.body.slice(0, 280);
          projected.bodyLength = record.body.length;
        } else {
          projected.bodyPreview = String(projected.bodyPreview ?? '').slice(0, 280);
          projected.bodyLength = Number(projected.bodyLength ?? 0);
        }
      }
      if (name === 'coordProjectMemories') {
        if (typeof record.content === 'string') {
          projected.contentPreview = record.content.slice(0, 280);
          projected.contentLength = record.content.length;
        } else {
          projected.contentPreview = String(projected.contentPreview ?? '').slice(0, 280);
          projected.contentLength = Number(projected.contentLength ?? 0);
        }
      }
      if (name === 'coordProjectFiles') {
        if (typeof record.content === 'string') {
          projected.sizeBytes = Buffer.byteLength(record.content, 'utf8');
          projected.contentTail = record.content.slice(-2);
        } else {
          projected.sizeBytes = Number(projected.sizeBytes ?? 0);
          projected.contentTail ??= '';
        }
      }
      if (name === 'agentBusConversations') {
        projected.lastToASequence ??= 0;
        projected.lastToBSequence ??= 0;
      }
      if (name === 'authPayloads') {
        const proof = record.canonicalBodyProof as
          | { sha256: string; lastRefresh: string; engine: string; bodyDigest: string }
          | null
          | undefined;
        projected.canonicalBodyProof =
          proof &&
          proof.sha256 === record.sha256 &&
          proof.lastRefresh === record.lastRefresh &&
          proof.engine === record.engine &&
          (!Object.hasOwn(record, 'body') ||
            (typeof record.body === 'string' &&
              createHash('sha256').update(record.body).digest('hex') === proof.bodyDigest))
            ? proof
            : null;
      }
      if (name === 'chattySessions') projected.eventCursor ??= 0;
      if (name === 'agentSessions') {
        projected.companionEvents ??= emptyCompanionEventIndex();
        projected.taskTitle ??= null;
        projected.taskTitleNativeId ??= null;
        projected.taskTitleEventId ??= null;
        projected.portalEventCursor ??= 0;
        projected.portalAttentionCursor ??= 0;
        projected.portalAttentionClearedCursor ??= 0;
        projected.portalLastEventType ??= null;
        projected.portalLastEventAt ??= null;
      }
      // Legacy credentials are reduced to a hash before entering owner state.
      if (name === 'hosts') {
        projected.registrationAt ??= null;
        const hash = typeof record.apiKeyHash === 'string' && record.apiKeyHash ? record.apiKeyHash : null;
        const key = typeof record.apiKey === 'string' ? record.apiKey : null;
        if (hash || key !== null) {
          projected.credentialLookupHash = hash ?? createHash('sha256').update(key!).digest('hex');
          projected.authFingerprint = createHash('sha256')
            .update(hash || key!)
            .digest('hex');
        }
      }
      if (name === 'sharedMemories') {
        if (typeof record.content === 'string') projected.contentPreview = record.content.slice(0, 400);
        else projected.contentPreview ??= '';
        projected.highestRevision ??= record.revision ?? 0;
      }
      if (name === 'companionDevices') {
        if (Object.hasOwn(record, 'fcmTokenEnc'))
          projected.pushTokenDigest =
            typeof record.fcmTokenEnc === 'string'
              ? createHash('sha256').update(record.fcmTokenEnc).digest('hex')
              : null;
        else projected.pushTokenDigest ??= null;
      }
      if (name === 'adminUsers' && typeof record.passwordHash === 'string')
        projected.credentialDigest = createHash('sha256').update(record.passwordHash).digest('hex');
      const row = copy(projected) as StateRow<K>;
      const key = this.keyFor(row);
      if (stored.has(key)) throw new Error(`Duplicate owner state key in ${name}`);
      rowSizes.set(row, metadataSize(row));
      stored.set(key, row);
    }
    this.#rows = stored;
    entityRows.set(this, stored as ReadonlyMap<string, RecordRow>);
    // Only newly projected rows are serialized; unchanged draft rows reuse their measured size.
    this.metadataBytes = 2 + Math.max(0, stored.size - 1);
    for (const row of stored.values()) this.metadataBytes += rowSizes.get(row)!;
    const indexes = new Map<string, ReadonlyMap<string, readonly string[]>>();
    for (const field of stateIndexFields(name)) {
      const index = new Map<string, string[]>();
      for (const [key, row] of stored) {
        const value = scalarKey((row as RecordRow)[field]);
        const keys = index.get(value) ?? [];
        keys.push(key);
        index.set(value, keys);
      }
      indexes.set(field, index);
    }
    this.#indexes = indexes;
    Object.freeze(this);
  }
  get size(): number {
    return this.#rows.size;
  }
  keyFor(row: Readonly<StateRow<K>>): string {
    const values = this.#keys.map((field) => (row as RecordRow)[field]);
    if (values.some((value) => !['string', 'number', 'bigint'].includes(typeof value)))
      throw new Error(`Missing stable state key in ${this.name}`);
    return keyOf(values as (string | number | bigint)[]);
  }
  get(key: Key): Readonly<StateRow<K>> | undefined {
    const value = this.#rows.get(keyOf(key));
    return value === undefined ? undefined : copy(value);
  }
  has(key: Key): boolean {
    return this.#rows.has(keyOf(key));
  }
  all(): readonly Readonly<StateRow<K>>[] {
    return Object.freeze([...this.#rows.values()].map(copy));
  }
  by<F extends keyof StateRow<K> & string>(
    field: F,
    value: StateRow<K>[F],
  ): readonly Readonly<StateRow<K>>[] {
    const index = this.#indexes.get(field);
    if (!index) throw new Error(`No owner index ${this.name}.${field}`);
    return Object.freeze((index.get(scalarKey(value)) ?? []).map((key) => copy(this.#rows.get(key)!)));
  }
}

type Views = { [K in OwnedTableName]: EntityView<K> };
export class OwnerStateSnapshot {
  readonly revision: StateRevision;
  readonly #views: Views;
  readonly messagingTotals: MessagingTotals;
  readonly metadataUsage: StateMetadataUsage;
  constructor(
    value: StateRevision,
    seed: StateSeed = {},
    previous?: OwnerStateSnapshot,
    changed?: ReadonlySet<OwnedTableName>,
    totals?: MessagingTotals,
  ) {
    this.revision = revision(value);
    this.messagingTotals = totals
      ? copy(totals)
      : (previous?.messagingTotals ?? copy(messagingTotalsFromSeed(seed)));
    this.#views = Object.fromEntries(
      OWNED_TABLE_NAMES.map((name) => [
        name,
        previous && !changed?.has(name)
          ? previous.table(name)
          : new EntityView(name, seed[name] ?? [], projectedSeeds.has(seed) ? projectedRows : undefined),
      ]),
    ) as Views;
    const tables = Object.fromEntries(
      OWNED_TABLE_NAMES.map((name) => [name, this.table(name).size]),
    ) as Record<OwnedTableName, number>;
    // Table sizes are cached. Derived aggregate rows are small, independently counted metadata.
    const aggregateRows =
      this.messagingTotals.bus.length +
      this.messagingTotals.portal.length +
      this.messagingTotals.responses.length;
    this.metadataUsage = Object.freeze({
      tables: Object.freeze(tables),
      rows: aggregateRows + OWNED_TABLE_NAMES.reduce((n, name) => n + tables[name], 0),
      metadataBytes:
        metadataSize(this.messagingTotals) +
        OWNED_TABLE_NAMES.reduce((n, name) => n + this.table(name).metadataBytes, 0),
    });
    Object.freeze(this);
  }
  table<K extends OwnedTableName>(name: K): EntityView<K> {
    return this.#views[name];
  }
  get hosts() {
    return this.table('hosts');
  }
  get settings() {
    return this.table('versions');
  }
  get accounts() {
    return this.table('providerAccounts');
  }
  get sessions() {
    return this.table('agentSessions');
  }
  get addresses() {
    return this.table('agentBusAddresses');
  }
  get messages() {
    return this.table('agentBusMessages');
  }
  get claims() {
    return this.table('agentResourceClaims');
  }
  get daemons() {
    return this.table('hostDaemons');
  }
  get adminSessions() {
    return this.table('adminSessions');
  }
  setting(name: string): string | null {
    return this.settings.get(name)?.version ?? null;
  }
}

const preparedSnapshots = new WeakMap<
  PreparedOwnerState,
  { base: OwnerStateSnapshot; snapshot: OwnerStateSnapshot }
>();
export class PreparedOwnerState {
  private constructor(readonly revision: StateRevision) {
    Object.freeze(this);
  }
  static fromDraft(base: OwnerStateSnapshot, snapshot: OwnerStateSnapshot): PreparedOwnerState {
    const result = new PreparedOwnerState(snapshot.revision);
    preparedSnapshots.set(result, { base, snapshot });
    return result;
  }
}

export class OwnerStateDraft {
  readonly #changed = new Map<OwnedTableName, Map<string, RecordRow>>();
  #sealed = false;
  #messagingTotals: MessagingTotals | undefined;
  adjustMessagingTotals(delta: MessagingTotalsDelta): void {
    this.#assertOpen();
    this.#messagingTotals = updateMessagingTotals(this.#messagingTotals ?? this.base.messagingTotals, delta);
  }
  constructor(readonly base: OwnerStateSnapshot) {}
  #assertOpen(): void {
    if (this.#sealed) throw new Error('Owner state draft is sealed');
  }
  #rows<K extends OwnedTableName>(name: K): Map<string, RecordRow> {
    this.#assertOpen();
    let rows = this.#changed.get(name);
    if (!rows) {
      const view = this.base.table(name);
      rows = new Map(entityRows.get(view)!);
      this.#changed.set(name, rows);
    }
    return rows;
  }
  table<K extends OwnedTableName>(name: K): EntityView<K> {
    const rows = this.#changed.get(name);
    return rows
      ? new EntityView(name, rows.values() as Iterable<StateRow<K>>, projectedRows)
      : this.base.table(name);
  }
  upsert<K extends OwnedTableName>(name: K, row: StateRow<K> | Row<K>): void {
    const view = new EntityView(name, [row]);
    const projected = entityRows.get(view)!.values().next().value! as StateRow<K>;
    this.#rows(name).set(view.keyFor(projected), projected as RecordRow);
  }
  remove(name: OwnedTableName, key: Key): void {
    this.#rows(name).delete(keyOf(key));
  }
  removeRow<K extends OwnedTableName>(name: K, row: Readonly<StateRow<K>>): void {
    this.#rows(name).delete(this.base.table(name).keyFor(row));
  }
  /** Read the command's composed changes without sealing or publishing them. */
  view(): OwnerStateSnapshot {
    this.#assertOpen();
    const seed = Object.fromEntries(
      [...this.#changed].map(([name, rows]) => [name, [...rows.values()]]),
    ) as StateSeed;
    projectedSeeds.add(seed);
    return new OwnerStateSnapshot(
      this.base.revision,
      seed,
      this.base,
      new Set(this.#changed.keys()),
      this.#messagingTotals,
    );
  }
  seal(next: StateRevision): PreparedOwnerState {
    this.#assertOpen();
    if (next.epoch !== this.base.revision.epoch || next.sequence !== this.base.revision.sequence + 1n)
      throw new Error('Owner state revision must advance exactly once');
    const seed = Object.fromEntries(
      [...this.#changed].map(([name, rows]) => [name, [...rows.values()]]),
    ) as StateSeed;
    projectedSeeds.add(seed);
    const snapshot = new OwnerStateSnapshot(
      next,
      seed,
      this.base,
      new Set(this.#changed.keys()),
      this.#messagingTotals,
    );
    this.#sealed = true;
    return PreparedOwnerState.fromDraft(this.base, snapshot);
  }
}

export class OwnerStateStore {
  #current: OwnerStateSnapshot;
  readonly #listeners = new Set<(snapshot: OwnerStateSnapshot) => void>();
  readonly limits: OwnerStateLimits;
  constructor(initial: OwnerStateSnapshot, overrides: Partial<OwnerStateLimits> = {}) {
    this.limits = Object.freeze({ ...DEFAULT_OWNER_STATE_LIMITS, ...overrides });
    for (const [name, value] of Object.entries(this.limits))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid owner state limit ${name}`);
    this.#checkLimits(initial);
    this.#current = initial;
  }
  #checkLimits(snapshot: OwnerStateSnapshot): void {
    for (const name of OWNED_TABLE_NAMES)
      if (snapshot.metadataUsage.tables[name] > this.limits.rowsPerTable)
        throw new Error(`Owner state exceeds row limit for ${name}`);
    if (snapshot.metadataUsage.rows > this.limits.totalRows)
      throw new Error('Owner state exceeds total row limit');
    if (snapshot.metadataUsage.metadataBytes > this.limits.metadataBytes)
      throw new Error('Owner state exceeds metadata byte limit');
  }
  snapshot(): OwnerStateSnapshot {
    return this.#current;
  }
  revision(): StateRevision {
    return this.#current.revision;
  }
  subscribe(listener: (snapshot: OwnerStateSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  begin(expected = this.#current.revision): OwnerStateDraft {
    if (!sameStateRevision(expected, this.#current.revision))
      throw new Error('Owner state revision conflict');
    return new OwnerStateDraft(this.#current);
  }
  /** Call before COMMIT; serialization guarantees it remains true until publish. */
  validate(prepared: PreparedOwnerState, expected?: StateRevision): void {
    if (expected && !sameStateRevision(prepared.revision, expected))
      throw new Error('Owner state publication revision conflict');
    const candidate = preparedSnapshots.get(prepared);
    if (candidate?.base !== this.#current) throw new Error('Owner state publication conflict');
    this.#checkLimits(candidate.snapshot);
  }
  publish(prepared: PreparedOwnerState): void {
    this.validate(prepared);
    this.#current = preparedSnapshots.get(prepared)!.snapshot;
    preparedSnapshots.delete(prepared);
    const errors: unknown[] = [];
    for (const listener of this.#listeners) {
      try {
        listener(this.#current);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Owner state subscriber failed; fence owner');
  }
}
