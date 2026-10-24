import { pruneRoomEventMetadata } from './room-heads.js';
import { protectOwnerReadHandle } from '../../db/fresh-read.js';
import type { DeadlineQueue } from '../deadlines.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Command, Json, Revision, OutboxIntent } from '../commands.js';
import type { PersistenceTransaction } from '../persistence.js';
import {
  OwnerStateDraft,
  type OwnerStateSnapshot,
  type OwnerStateStore,
  type PreparedOwnerState,
} from './store.js';
import { pruneDomainHistory } from './working-history.js';

export interface OwnerRuntime {
  readonly state: OwnerStateStore;
  readonly deadlines: DeadlineQueue;
  assertOwner(): void;
  execute(command: Command<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>): Promise<Json>;
}
const bindings = new WeakMap<object, OwnerRuntime>();
const activeCommand = new AsyncLocalStorage<OwnerRuntime>();
const persistenceContext = new AsyncLocalStorage<{ handle: object; context: OwnerMutationContext }>();
/** Domain persistence helpers may project only the transaction they are executing. */
export function ownerMutationContextFor(handle: object): OwnerMutationContext | undefined {
  const active = persistenceContext.getStore();
  return active?.handle === handle ? active.context : undefined;
}
export interface OwnerRequestPrincipal {
  principal: string;
  revalidate(snapshot: OwnerStateSnapshot): void;
}
export class OwnerActionCompositionError extends Error {}
export interface OwnerActionIdentity {
  id: string;
  principal: OwnerRequestPrincipal;
  revalidateTarget(snapshot: OwnerStateSnapshot): void;
  afterPrepare?(context: OwnerMutationContext, result: () => Json): void;
}
interface OwnerRequestScope {
  runtime?: OwnerRuntime;
  principal?: OwnerRequestPrincipal;
  action?: OwnerActionIdentity & { invoked: boolean };
  proofs?: Map<string, (snapshot: OwnerStateSnapshot) => void>;
  committedResponse?: boolean;
  rpcResponses?: Array<{ response: unknown; scope: OwnerRequestScope }>;
}
export function addOwnerResponseProof(key: string, proof: (snapshot: OwnerStateSnapshot) => void): void {
  const scope = requestScope.getStore();
  if (scope) {
    scope.proofs ??= new Map();
    scope.proofs.set(key, proof);
  }
}
/** Each JSON-RPC item has its own action receipt; one write cannot authorize a sibling read. */
export async function withOwnerRpcResponse<T>(run: () => Promise<T>): Promise<T> {
  const outer = requestScope.getStore();
  if (!outer) return run();
  const child: OwnerRequestScope = {
    runtime: outer.runtime,
    principal: outer.principal,
    proofs: new Map(outer.proofs),
  };
  return requestScope.run(child, async () => {
    const response = await run();
    outer.rpcResponses ??= [];
    outer.rpcResponses.push({ response, scope: child });
    return response;
  });
}
function checkResponseScope(
  runtime: OwnerRuntime,
  scope: OwnerRequestScope | undefined,
  allowCommit = false,
): void {
  runtime.assertOwner();
  if (allowCommit && scope?.committedResponse) return;
  const snapshot = runtime.state.snapshot();
  scope?.principal?.revalidate(snapshot);
  for (const proof of scope?.proofs?.values() ?? []) proof(snapshot);
}
/** Capture before leaving HTTP ALS, e.g. for every chunk of a protected file stream. */
export function bindOwnerResponseRuntime(runtime: OwnerRuntime): void {
  const scope = requestScope.getStore();
  if (scope) scope.runtime = runtime;
}
export function assertOwnerRequestAuthority(): void {
  const scope = requestScope.getStore();
  if (scope?.runtime) checkResponseScope(scope.runtime, scope);
}
export function ownerReadResponseGuard(runtime: OwnerRuntime): () => void {
  const scope = requestScope.getStore();
  return () => checkResponseScope(runtime, scope);
}
/** Capture the authenticated request scope for later transport callbacks. */
export function ownerResponseFinalizer(runtime: OwnerRuntime): (payload: unknown, allowCommitted?: boolean) => unknown {
  const scope = requestScope.getStore();
  return (payload, allowCommitted = false) => requestScope.run(scope ?? {}, () => finalizeOwnerResponse(runtime, payload, allowCommitted));
}
export function finalizeOwnerResponse(
  runtime: OwnerRuntime,
  payload: unknown,
  allowCommitted = false,
): unknown {
  runtime.assertOwner();
  const scope = requestScope.getStore(),
    units = scope?.rpcResponses;
  if (
    units?.length &&
    units.every((unit) => unit.response === null) &&
    (payload === undefined || payload === null || payload === '')
  ) {
    if (!units.some((unit) => unit.scope.committedResponse)) checkResponseScope(runtime, scope);
    return payload;
  }
  if (units?.length && typeof payload === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      checkResponseScope(runtime, scope);
      return payload;
    }
    const expected = units.filter((unit) => unit.response !== null),
      responses = Array.isArray(parsed) ? parsed : [parsed];
    if (responses.length !== expected.length) {
      checkResponseScope(runtime, scope);
      return payload;
    }
    const finish = (response: unknown, index: number) => {
      const unit = expected[index]!;
      const denied = {
        jsonrpc: '2.0',
        id: (unit.response as { id?: unknown })?.id ?? null,
        error: { code: -32001, message: 'Response authority expired or was revoked' },
      };
      // A prior boundary may already have replaced this exact item with a safe denial.
      if (JSON.stringify(response) === JSON.stringify(denied)) return response;
      if (JSON.stringify(unit.response) !== JSON.stringify(response)) {
        checkResponseScope(runtime, scope);
        return response;
      }
      try {
        checkResponseScope(runtime, unit.scope, true);
        return response;
      } catch {
        return {
          jsonrpc: '2.0',
          id: (response as { id?: unknown })?.id ?? null,
          error: { code: -32001, message: 'Response authority expired or was revoked' },
        };
      }
    };
    return JSON.stringify(Array.isArray(parsed) ? responses.map(finish) : finish(parsed, 0));
  }
  checkResponseScope(runtime, scope, allowCommitted);
  return payload;
}
const requestScope = new AsyncLocalStorage<OwnerRequestScope>();
export function withOwnerRequestScope<T>(run: () => T): T {
  return requestScope.run({}, run);
}
/** A deadline is a system obligation, never a continuation of its triggering
 * HTTP caller or prepared tool action. Domain handlers authorize their own work. */
export function withOwnerBackgroundScope<T>(run: () => T): T {
  return activeCommand.exit(() => requestScope.run({}, run));
}
/** One audited domain command per prepared action; compound tools must compose explicitly. */
export function withOwnerActionIdentity<T>(identity: OwnerActionIdentity, run: () => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(identity.id) || requestScope.getStore()?.action)
    throw new Error('Invalid nested owner action');
  const parent = requestScope.getStore();
  return requestScope.run(
    {
      runtime: parent?.runtime,
      proofs: new Map(parent?.proofs),
      principal: identity.principal,
      action: { ...identity, invoked: false },
    },
    run,
  );
}
export function setOwnerRequestPrincipal(principal: OwnerRequestPrincipal): void {
  const scope = requestScope.getStore();
  if (scope) {
    scope.principal = principal;
    addOwnerResponseProof(principal.principal, principal.revalidate);
  }
}

/** Bind the API facade and its owner-only transaction handles, never a cache. */
export function bindOwnerRuntime(handle: object, runtime: OwnerRuntime): void {
  const previous = bindings.get(handle);
  if (previous && previous !== runtime) throw new Error('Database handle already belongs to another owner');
  bindings.set(handle, runtime);
  protectOwnerReadHandle(handle);
}
export function ownerRuntimeFor(handle: object): OwnerRuntime | undefined {
  return bindings.get(handle);
}
export function requireOwnerRuntime(handle: object): OwnerRuntime {
  const owner = ownerRuntimeFor(handle);
  if (!owner) throw new Error('Control-plane owner is not bound');
  owner.assertOwner();
  return owner;
}
export function withOwnerCommandContext<T>(runtime: OwnerRuntime, run: () => T): T {
  if (activeCommand.getStore())
    throw new Error('Nested owner command is forbidden; share its draft and persistence transaction');
  return activeCommand.run(runtime, run);
}

export interface OwnerMutation {
  readonly kind: string;
  readonly payload: Json;
  readonly principal?: string;
  readonly id?: string;
  /** Only explicit domain action results, never audit observations or renewal. */
  readonly responseAuthorization?: 'commit';
  authorize?(snapshot: OwnerStateSnapshot): void;
  /** Cold immutable history/content may be read here using a separate read connection. */
  prepare(context: OwnerMutationContext): Json | (() => Json) | Promise<Json | (() => Json)>;
}
export interface OwnerMutationContext {
  readonly snapshot: OwnerStateSnapshot;
  readonly draft: OwnerStateDraft;
  readonly revision: Revision;
  write(operation: (tx: PersistenceTransaction) => Promise<unknown>): void;
  effect(intent: OutboxIntent): void;
}

/** Service commands compose typed rows and explicit persistence; no SQL introspection. */
export async function mutateOwnerState(runtime: OwnerRuntime, mutation: OwnerMutation): Promise<Json> {
  if (activeCommand.getStore())
    throw new Error('Nested owner command is forbidden; share its draft and persistence transaction');
  runtime.assertOwner();
  const scope = requestScope.getStore();
  const principal = scope?.principal,
    action = scope?.action;
  const authorityProofs = [...(scope?.proofs?.values() ?? [])];
  if (action?.invoked)
    throw new OwnerActionCompositionError('Prepared action attempted more than one domain command');
  if (action) action.invoked = true;
  let preparedAction = false;
  const commandPrincipal =
    action?.principal.principal ?? mutation.principal ?? principal?.principal ?? 'system:control-plane';
  const commandId = action?.id ?? mutation.id ?? randomUUID();
  const outcome = await runtime.execute({
    principal: commandPrincipal,
    id: commandId,
    replayClass: action || mutation.id ? 'external' : 'internal',
    kind: mutation.kind,
    payload: mutation.payload,
    authorize(snapshot) {
      runtime.assertOwner();
      principal?.revalidate(snapshot);
      for (const proof of authorityProofs) proof(snapshot);
      mutation.authorize?.(snapshot);
      if (preparedAction) action?.revalidateTarget(snapshot);
    },
    prepare(snapshot, revision) {
      action?.revalidateTarget(snapshot);
      preparedAction = true;
      return withOwnerCommandContext(runtime, async () => {
        const draft = runtime.state.begin(snapshot.revision);
        const writes: Array<(tx: PersistenceTransaction) => Promise<unknown>> = [];
        const outbox: OutboxIntent[] = [];
        let accepting = true;
        const assertAccepting = () => {
          if (!accepting) throw new Error('Owner mutation context is sealed');
        };
        const context: OwnerMutationContext = {
          snapshot,
          draft,
          revision,
          write(operation) {
            assertAccepting();
            writes.push(operation);
          },
          effect(intent) {
            assertAccepting();
            if (
              !/^[0-9a-f-]{36}$/i.test(intent.id) ||
              !intent.kind ||
              intent.kind.length > 191 ||
              intent.target.length > 255 ||
              !Number.isFinite(Date.parse(intent.availableAt))
            )
              throw new Error('Invalid durable effect');
            if (
              outbox.some((existing) => existing.id === intent.id) ||
              snapshot.table('controlPlaneOutbox').has(intent.id)
            )
              throw new Error('Duplicate durable effect identity');
            draft.upsert('controlPlaneOutbox', {
              id: intent.id,
              principal: commandPrincipal,
              requestId: commandId,
              kind: intent.kind,
              target: intent.target,
              status: 'pending',
              attempts: 0,
              availableAt: intent.availableAt,
              createdAt: new Date().toISOString(),
              completedAt: null,
            });
            outbox.push(structuredClone(intent));
          },
        };
        const result = await mutation.prepare(context);
        action?.afterPrepare?.(context, () => (typeof result === 'function' ? result() : result));
        return {
          result,
          outbox,
          async persist(tx) {
            try {
              bindOwnerRuntime(tx, runtime);
              await withOwnerCommandContext(runtime, async () => {
                await persistenceContext.run({ handle: tx, context }, async () => {
                  for (const operation of writes) await operation(tx);
                });
              });
              pruneDomainHistory(draft);
              pruneRoomEventMetadata(draft);
              return draft.seal(revision);
            } finally {
              accepting = false;
            }
          },
        };
      });
    },
  });
  if (scope && mutation.responseAuthorization === 'commit') scope.committedResponse = true;
  return outcome;
}
