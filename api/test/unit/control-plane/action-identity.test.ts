import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  mutateOwnerState,
  withOwnerActionIdentity,
  type OwnerMutationContext,
  type OwnerRuntime,
} from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
function fixture() {
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {}));
  const execute = vi.fn<OwnerRuntime['execute']>(async (command) => {
    const snapshot = state.snapshot();
    command.authorize(snapshot);
    const prepared = await command.prepare(snapshot, { ...snapshot.revision, sequence: 1n });
    command.authorize(snapshot);
    return typeof prepared.result === 'function' ? prepared.result() : prepared.result;
  });
  const runtime = { state, assertOwner: () => {}, execute } as unknown as OwnerRuntime;
  const actor = vi.fn(),
    target = vi.fn();
  const identity = {
    id: randomUUID(),
    principal: { principal: 'admin:42', revalidate: actor },
    revalidateTarget: target,
  };
  return { runtime, execute, identity, actor, target };
}
describe('prepared action command identity', () => {
  it('rejects retained writes and effects after the persisted draft is sealed', async () => {
    const f = fixture();
    let retained!: OwnerMutationContext;
    f.execute.mockImplementation(async (command) => {
      const snapshot = f.runtime.state.snapshot();
      const prepared = await command.prepare(snapshot, { ...snapshot.revision, sequence: 1n });
      const state = await prepared.persist(
        {} as import('../../../src/control-plane/persistence.js').PersistenceTransaction,
      );
      expect(state).toBeDefined();
      expect(() => retained.write(async () => {})).toThrow('sealed');
      expect(() =>
        retained.effect({
          id: randomUUID(),
          kind: 'late',
          target: 'object',
          payload: {},
          availableAt: new Date().toISOString(),
        }),
      ).toThrow('sealed');
      expect(prepared.outbox).toEqual([]);
      return null;
    });
    await mutateOwnerState(f.runtime, {
      kind: 'sealed',
      payload: {},
      prepare(context) {
        retained = context;
        return null;
      },
    });
  });
  it('uses the stable action UUID and authenticated principal for the service command', async () => {
    const f = fixture();
    await withOwnerActionIdentity(f.identity, () =>
      mutateOwnerState(f.runtime, {
        kind: 'domain.edit',
        payload: {},
        principal: 'system',
        prepare: () => true,
      }),
    );
    expect(f.execute.mock.calls[0]![0]).toMatchObject({ id: f.identity.id, principal: 'admin:42' });
    expect(f.actor).toHaveBeenCalledTimes(2);
    expect(f.target).toHaveBeenCalledTimes(2);
  });
  it('rejects a second command before it can execute', async () => {
    const f = fixture();
    await expect(
      withOwnerActionIdentity(f.identity, async () => {
        await mutateOwnerState(f.runtime, { kind: 'first', payload: {}, prepare: () => true });
        return mutateOwnerState(f.runtime, { kind: 'second', payload: {}, prepare: () => true });
      }),
    ).rejects.toThrow('more than one');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects a changed target before preparing or committing', async () => {
    const f = fixture();
    f.target.mockImplementation(() => {
      throw new Error('target changed');
    });
    const prepare = vi.fn(() => true);
    await expect(
      withOwnerActionIdentity(f.identity, () =>
        mutateOwnerState(f.runtime, { kind: 'edit', payload: {}, prepare }),
      ),
    ).rejects.toThrow('target changed');
    expect(prepare).not.toHaveBeenCalled();
    f.target.mockReset();
    let valid = true;
    f.target.mockImplementation(() => {
      if (!valid) throw new Error('target changed');
    });
    await expect(
      withOwnerActionIdentity({ ...f.identity, id: randomUUID() }, () =>
        mutateOwnerState(f.runtime, {
          kind: 'edit',
          payload: {},
          prepare: async () => {
            await Promise.resolve();
            valid = false;
            return true;
          },
        }),
      ),
    ).rejects.toThrow('target changed');
  });
  it('reauthorizes a receipt replay without requiring the already-mutated target to match', async () => {
    const f = fixture();
    f.execute.mockImplementation(async (command) => {
      command.authorize(f.runtime.state.snapshot());
      return { replayed: true };
    });
    f.target.mockImplementation(() => {
      throw new Error('old target');
    });
    expect(
      await withOwnerActionIdentity(f.identity, () =>
        mutateOwnerState(f.runtime, { kind: 'edit', payload: {}, prepare: () => false }),
      ),
    ).toEqual({ replayed: true });
    expect(f.actor).toHaveBeenCalledOnce();
    expect(f.target).not.toHaveBeenCalled();
  });
  it('finalizes the action in the same persistence unit after generated results exist', async () => {
    const f = fixture();
    const order: string[] = [];
    let generated = 0;
    f.execute.mockImplementation(async (command) => {
      const snapshot = f.runtime.state.snapshot();
      command.authorize(snapshot);
      const prepared = await command.prepare(snapshot, { ...snapshot.revision, sequence: 1n });
      await prepared.persist(
        {} as import('../../../src/control-plane/persistence.js').PersistenceTransaction,
      );
      command.authorize(snapshot);
      return typeof prepared.result === 'function' ? prepared.result() : prepared.result;
    });
    const result = await withOwnerActionIdentity(
      {
        ...f.identity,
        afterPrepare(context, readResult) {
          context.write(async () => {
            order.push('receipt');
            expect(readResult()).toEqual({ id: 42 });
          });
        },
      },
      () =>
        mutateOwnerState(f.runtime, {
          kind: 'generated',
          payload: {},
          prepare(context) {
            context.write(async () => {
              generated = 42;
              order.push('domain');
            });
            return () => ({ id: generated });
          },
        }),
    );
    expect(result).toEqual({ id: 42 });
    expect(order).toEqual(['domain', 'receipt']);
  });
});
