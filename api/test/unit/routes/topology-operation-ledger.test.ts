import { describe, expect, it } from 'vitest';
import { OperationLedger } from '../../../src/routes/admin/topology/operation-ledger.js';

type Result = { value: string; replayed: boolean };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('OperationLedger', () => {
  it('runs one execution for concurrent retries of one key and marks the joiner replayed', async () => {
    const ledger = new OperationLedger<'a'>({ ttlMs: 60_000, max: 8 });
    const g = gate();
    let runs = 0;
    const run = async (): Promise<Result> => {
      runs += 1;
      await g.opened;
      return { value: 'x', replayed: false };
    };
    const first = ledger.once('k', 't1', 'a', run);
    const second = ledger.once('k', 't1', 'a', run);
    g.open();
    expect((await Promise.all([first, second])).map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(runs).toBe(1);
  });

  it('refuses the same key for another target or another action before running anything', async () => {
    const ledger = new OperationLedger<'a' | 'b'>({ ttlMs: 60_000, max: 8 });
    const g = gate();
    let runs = 0;
    const run = async (): Promise<Result> => {
      runs += 1;
      await g.opened;
      return { value: 'x', replayed: false };
    };
    const first = ledger.once('k', 't1', 'a', run);
    await expect(ledger.once('k', 't2', 'a', run)).rejects.toMatchObject({ code: 'client_message_id_reused' });
    await expect(ledger.once('k', 't1', 'b', run)).rejects.toMatchObject({ code: 'client_message_id_reused' });
    g.open();
    await first;
    expect(runs).toBe(1);
  });

  it('never evicts a running operation, however many others are running: its retry still joins', async () => {
    const ledger = new OperationLedger<'a'>({ ttlMs: 60_000, max: 4 });
    const g = gate();
    let runsForFirst = 0;
    const first = ledger.once('first', 't', 'a', async (): Promise<Result> => {
      runsForFirst += 1;
      await g.opened;
      return { value: 'first', replayed: false };
    });
    const others = Array.from({ length: 20 }, (_, i) =>
      ledger.once(`other-${i}`, `t${i}`, 'a', async (): Promise<Result> => {
        await g.opened;
        return { value: String(i), replayed: false };
      }),
    );
    const retry = ledger.once('first', 't', 'a', async (): Promise<Result> => {
      runsForFirst += 1;
      return { value: 'second-run', replayed: false };
    });
    g.open();
    const [a, again] = await Promise.all([first, retry]);
    await Promise.all(others);
    expect(runsForFirst).toBe(1);
    expect(a.value).toBe('first');
    expect(again).toMatchObject({ value: 'first', replayed: true });
  });

  it('bounds memory by dropping the oldest settled entries only', async () => {
    const ledger = new OperationLedger<'a'>({ ttlMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i += 1) await ledger.once(`k${i}`, 't', 'a', async (): Promise<Result> => ({ value: String(i), replayed: false }));
    expect(ledger.size).toBe(3);
    await ledger.once('k3', 't', 'a', async (): Promise<Result> => ({ value: '3', replayed: false }));
    expect(ledger.size).toBe(3);
    // k0 was the oldest settled and is gone: its key runs again; k3 is still remembered.
    let runs = 0;
    await ledger.once('k0', 't', 'a', async (): Promise<Result> => ((runs += 1), { value: '0', replayed: false }));
    expect(runs).toBe(1);
    expect((await ledger.once('k3', 't', 'a', async (): Promise<Result> => ({ value: 'again', replayed: false }))).replayed).toBe(true);
  });

  it('frees the key of a failed attempt so the operator can retry it', async () => {
    const ledger = new OperationLedger<'a'>({ ttlMs: 60_000, max: 8 });
    await expect(ledger.once('k', 't', 'a', async (): Promise<Result> => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(ledger.size).toBe(0);
    expect((await ledger.once('k', 't', 'a', async (): Promise<Result> => ({ value: 'ok', replayed: false }))).replayed).toBe(false);
  });

  it('forgets settled entries after the ttl but not running ones', async () => {
    let now = 1_000;
    const ledger = new OperationLedger<'a'>({ ttlMs: 100, max: 8, now: () => now });
    const g = gate();
    let runningRuns = 0;
    const running = ledger.once('running', 't', 'a', async (): Promise<Result> => {
      runningRuns += 1;
      await g.opened;
      return { value: 'r', replayed: false };
    });
    await ledger.once('done', 't', 'a', async (): Promise<Result> => ({ value: 'd', replayed: false }));
    now += 500;
    let reran = 0;
    await ledger.once('done', 't', 'a', async (): Promise<Result> => ((reran += 1), { value: 'd2', replayed: false }));
    expect(reran).toBe(1);
    const retry = ledger.once('running', 't', 'a', async (): Promise<Result> => ((runningRuns += 1), { value: 'again', replayed: false }));
    g.open();
    expect((await Promise.all([running, retry])).map((r) => r.replayed)).toEqual([false, true]);
    expect(runningRuns).toBe(1);
  });
});
