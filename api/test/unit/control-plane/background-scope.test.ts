import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import {
  mutateOwnerState,
  withOwnerActionIdentity,
  withOwnerCommandContext,
  type OwnerRuntime,
} from '../../../src/control-plane/state/runtime.js';
afterEach(() => vi.useRealTimers());
it('does not lend a triggering request or action identity to its background deadline', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const errors = vi.fn(),
    deadlines = new DeadlineQueue(errors),
    state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }));
  const execute = vi.fn<OwnerRuntime['execute']>(async (command) => {
    command.authorize(state.snapshot());
    return command.principal;
  });
  const runtime: OwnerRuntime = { state, deadlines, assertOwner: () => {}, execute };
  const denied = vi.fn(() => {
    throw new Error('Caller revoked');
  });
  await withOwnerActionIdentity(
    {
      id: randomUUID(),
      principal: { principal: 'revoked-caller', revalidate: denied },
      revalidateTarget: denied,
    },
    async () =>
      withOwnerCommandContext(runtime, () => {
        deadlines.schedule('system-work', 1, async () => {
          await mutateOwnerState(runtime, { kind: 'system.work', payload: {}, prepare: () => null });
        });
      }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].principal).toBe('system:control-plane');
  expect(denied).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  deadlines.close();
});
