import { describe, expect, it, vi } from 'vitest';
import {
  CommandExecutor,
  CommitUncertainError,
  canonicalCommand,
  type Command,
  type CommandReceipt,
  type CommandPersistence,
  type Revision,
  type OutboxIntent,
} from '../../../src/control-plane/commands.js';

interface State {
  revision: Revision;
  value: number;
}
function fixture() {
  let state: State = { revision: { epoch: 'owner', sequence: 0n }, value: 0 };
  let available = true;
  const durable = new Map<string, CommandReceipt>();
  let staging: CommandReceipt | undefined;
  const persist: CommandPersistence<null> = {
    receipt: vi.fn(async (p, id) => durable.get(p + ':' + id)),
    transaction: vi.fn(async (run) => {
      await run(null);
      if (staging) durable.set(staging.principal + ':' + staging.id, structuredClone(staging));
    }),
    record: vi.fn(async (_, receipt) => {
      staging = receipt;
    }),
  };
  const publish = vi.fn((next: State) => {
    state = next;
  });
  const lose = vi.fn(() => {
    available = false;
  });
  const changed = vi.fn();
  const executor = new CommandExecutor({
    state: {
      snapshot: () => state,
      revision: () => state.revision,
      validate: (next: State, revision: Revision) => {
        expect(next.revision).toEqual(revision);
      },
      publish,
    },
    persistence: persist,
    assertOwner: () => {
      if (!available) throw new Error('unavailable');
    },
    loseOwner: lose,
    committed: changed,
    notificationError: vi.fn(),
  });
  const command = (id: string): Command<State, null, State> => ({
    principal: 'alice',
    id,
    kind: 'increment',
    payload: {},
    authorize: () => {},
    prepare: (snapshot, revision) => ({
      state: { revision, value: snapshot.value + 1 },
      result: { value: snapshot.value + 1 },
      persist: async () => {},
    }),
  });
  return { executor, command, persist, publish, lose, durable, changed, state: () => state };
}

describe('authoritative command path', () => {
  it.each(['principal', 'id', 'kind', 'nested payload'])(
    'rejects a changed %s before executing a queued command',
    async (field) => {
      const f = fixture(),
        command = f.command('captured');
      command.payload = { nested: { values: [1] } };
      const prepare = vi.spyOn(command, 'prepare');
      const pending = f.executor.execute(command);
      if (field === 'nested payload')
        (command.payload as { nested: { values: number[] } }).nested.values[0] = 2;
      else command[field as 'principal' | 'id' | 'kind'] = 'changed';
      await expect(pending).rejects.toThrow('envelope changed');
      expect(prepare).not.toHaveBeenCalled();
      expect(f.persist.transaction).not.toHaveBeenCalled();
      expect(f.durable.size).toBe(0);
    },
  );
  it('rejects caller-owned payload changes before the persistence commit boundary', async () => {
    const f = fixture(), command = f.command('commit-closure');
    const input = { nested: { value: 1 } };
    command.payload = input;
    command.prepare = (_, revision) => ({
      result: input,
      persist: async () => {
        input.nested.value = 2;
        return { revision, value: input.nested.value };
      },
    });
    await expect(f.executor.execute(command)).rejects.toThrow('envelope changed');
    expect(f.persist.transaction).toHaveBeenCalledTimes(1);
    expect(f.durable.size).toBe(0);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('captures callbacks and provides a detached recursively frozen payload', async () => {
    const f = fixture(),
      command = f.command('callbacks');
    command.payload = { nested: { values: [1] } };
    command.prepare = function (snapshot, revision) {
      expect(this.payload).not.toBe(command.payload);
      expect(Object.isFrozen((this.payload as { nested: unknown }).nested)).toBe(true);
      expect(Object.isFrozen((this.payload as { nested: { values: unknown } }).nested.values)).toBe(true);
      return {
        state: { revision, value: snapshot.value + 1 },
        result: this.payload,
        persist: async () => {},
      };
    };
    const pending = f.executor.execute(command);
    command.prepare = () => {
      throw new Error('replacement callback must not run');
    };
    expect(await pending).toEqual({ nested: { values: [1] } });
  });
  it('rolls back mutation of caller-owned payload captured by an async prepare closure', async () => {
    const f = fixture(),
      command = f.command('closure');
    const input = { nested: { value: 1 } };
    command.payload = input;
    let resume!: () => void;
    let preparing!: () => void;
    const started = new Promise<void>((resolve) => {
      preparing = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    command.prepare = async (_, revision) => {
      preparing();
      await waiting;
      return { state: { revision, value: input.nested.value }, result: input, persist: async () => {} };
    };
    const pending = f.executor.execute(command);
    await started;
    input.nested.value = 2;
    resume();
    await expect(pending).rejects.toThrow('envelope changed');
    expect(f.persist.transaction).not.toHaveBeenCalled();
    expect(f.state().value).toBe(0);
  });

  it('keeps a compact receipt as a fail-closed duplicate-execution fence', async () => {
    const f = fixture(), command = f.command('expired');
    const prepare = vi.spyOn(command, 'prepare');
    await f.executor.execute(command);
    const receipt = f.durable.get('alice:expired')!;
    receipt.resultState = 'expired'; receipt.result = null;
    await expect(f.executor.execute(command)).rejects.toMatchObject({ status: 410, code: 'command_result_expired' });
    expect(prepare).toHaveBeenCalledTimes(1);
    await expect(f.executor.execute({ ...command, payload: { changed: true } })).rejects.toThrow('different payload');
    command.authorize = () => { throw new Error('revoked'); };
    await expect(f.executor.execute(command)).rejects.toThrow('revoked');
    expect(f.state().value).toBe(1);
  });
  it('serializes concurrent mutations and acknowledges only published commits', async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 20 }, (_, i) => f.executor.execute(f.command(String(i)))));
    expect(f.state().value).toBe(20);
    expect(f.state().revision.sequence).toBe(20n);
    expect(f.durable.size).toBe(20);
    expect(f.changed).toHaveBeenCalledTimes(20);
  });
  it('replays a committed result without execution and reauthorizes first', async () => {
    const f = fixture();
    const command = f.command('same');
    const prepare = vi.spyOn(command, 'prepare');
    await f.executor.execute(command);
    expect(await f.executor.execute(command)).toEqual({ value: 1 });
    expect(prepare).toHaveBeenCalledTimes(1);
    command.authorize = () => {
      throw new Error('revoked');
    };
    await expect(f.executor.execute(command)).rejects.toThrow('revoked');
  });
  it.each([true, false])('rechecks volatile authority after receipt I/O (replay=%s)', async (replay) => {
    const f = fixture();
    const command = f.command('receipt-race');
    if (replay) await f.executor.execute(command);
    const prepare = vi.spyOn(command, 'prepare');
    vi.mocked(f.persist.transaction).mockClear();
    let authorized = true;
    command.authorize = () => {
      if (!authorized) throw new Error(replay ? 'connection revoked' : 'deadline expired');
    };
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const paused = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(f.persist.receipt).mockImplementationOnce(async (principal, id) => {
      started();
      await paused;
      return f.durable.get(principal + ':' + id);
    });
    const pending = f.executor.execute(command);
    const rejected = expect(pending).rejects.toThrow(replay ? 'connection revoked' : 'deadline expired');
    await reading;
    authorized = false;
    finish();
    await rejected;
    expect(prepare).not.toHaveBeenCalled();
    expect(f.persist.transaction).not.toHaveBeenCalled();
  });
  it('rejects ID reuse across payloads and command kinds', async () => {
    const f = fixture();
    await f.executor.execute(f.command('same'));
    await expect(f.executor.execute({ ...f.command('same'), payload: { different: true } })).rejects.toThrow(
      'reused',
    );
    await expect(f.executor.execute({ ...f.command('same'), kind: 'delete' })).rejects.toThrow('reused');
  });
  it('never publishes rolled-back changes and continues after a known rejection', async () => {
    const f = fixture();
    const invalid = f.command('bad');
    invalid.prepare = () => {
      throw new Error('invalid');
    };
    await expect(f.executor.execute(invalid)).rejects.toThrow('invalid');
    expect(f.persist.transaction).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    await f.executor.execute(f.command('valid'));
    expect(f.state().value).toBe(1);
  });
  it('fails closed on ambiguous commit and rejects queued successors', async () => {
    const f = fixture();
    vi.mocked(f.persist.transaction).mockRejectedValueOnce(new CommitUncertainError('lost ACK'));
    const first = f.executor.execute(f.command('first'));
    const next = f.executor.execute(f.command('next'));
    await expect(first).rejects.toThrow('unknown');
    await expect(next).rejects.toThrow('unavailable');
    expect(f.lose).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('keeps committed receipt if publication fails, without acknowledging success', async () => {
    const f = fixture();
    f.publish.mockImplementationOnce(() => {
      throw new Error('projection failed');
    });
    await expect(f.executor.execute(f.command('committed'))).rejects.toThrow('reconstruction');
    expect(f.durable.has('alice:committed')).toBe(true);
    expect(f.lose).toHaveBeenCalledTimes(1);
    expect(f.changed).not.toHaveBeenCalled();
  });
  it('supports generated identifiers sealed before COMMIT', async () => {
    const f = fixture(),
      command = f.command('create');
    let generatedId = 0;
    command.prepare = (_, revision) => ({
      result: () => ({ id: generatedId }),
      persist: async () => {
        generatedId = 42;
        return { revision, value: generatedId };
      },
    });
    expect(await f.executor.execute(command)).toEqual({ id: 42 });
    expect(f.state().value).toBe(42);
    expect(await f.executor.execute(command)).toEqual({ id: 42 });
  });
  it('records effects that depend on insert-generated identities before commit', async () => {
    const f = fixture(),
      command = f.command('generated-effect'),
      effects: OutboxIntent[] = [];
    command.prepare = (_, revision) => ({
      outbox: effects,
      result: { id: 42 },
      persist: async () => {
        effects.push({
          id: '00000000-0000-4000-8000-000000000042',
          kind: 'fixture.created',
          target: '42',
          payload: { id: 42 },
          availableAt: new Date().toISOString(),
        });
        return { revision, value: 42 };
      },
    });
    await f.executor.execute(command);
    expect(vi.mocked(f.persist.record).mock.calls[0]![2]).toEqual(effects);
    expect(f.changed.mock.calls[0]![1]).toEqual(effects);
    effects[0]!.payload = { id: 0 };
    expect((vi.mocked(f.persist.record).mock.calls[0]![2]![0]!.payload as { id: number }).id).toBe(42);
  });
  it('does no persistence without commands and refuses admission after draining', async () => {
    const f = fixture();
    await f.executor.drain();
    expect(f.persist.receipt).not.toHaveBeenCalled();
    expect(f.persist.transaction).not.toHaveBeenCalled();
    await expect(f.executor.execute(f.command('late'))).rejects.toThrow('admission');
  });
  it('uses stable JSON digests and rejects lossy input', () => {
    expect(canonicalCommand({ b: 1, a: [true] })).toBe(canonicalCommand({ a: [true], b: 1 }));
    expect(() => canonicalCommand({ value: NaN })).toThrow('non-finite');
  });
});
