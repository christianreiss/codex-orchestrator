import { describe, expect, it, vi } from 'vitest';
import { CommunicatorRegistry } from '../../../src/services/topology/communicator-registry.js';

describe('topology terminate evidence', () => {
  it('refuses another stop while an acknowledged owner has not yet closed', async () => {
    const registry = new CommunicatorRegistry();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const instance = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const send = vi.fn((value: unknown) => {
      const command = value as { request_id: string };
      registry.acknowledgeTerminate(id, command.request_id, { accepted: true, pid: 1234, reason: null, instance_id: instance });
    });
    registry.register({ id, host_id: 42, username: 'fixture', version: '0.9.78', connected_at: new Date().toISOString(), sessions: 0, requests: 0, synced_at: null }, { close: vi.fn(), send, remoteAddress: null });
    registry.setCapabilities(id, { terminate: true, pid: 1234, started_at: null, instance_id: instance, runtime_id: 'aaaaaaaaaaaaaaaa' });
    const first = registry.terminate(id, 'fixture:first-key', { ackMs: 30, closeMs: 1000 });
    await vi.waitFor(() => expect(registry.get(id)?.closing).toBe(true), { interval: 1 });
    const second = await registry.terminate(id, 'fixture:other-key', { ackMs: 30, closeMs: 30 });
    registry.unregister(id);
    await first;
    console.info('second stop after ACK effects', { second, sends: send.mock.calls.length });
    expect(second.outcome).toBe('in_progress');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a foreign instance ACK and leaves the target connection alone', async () => {
    const registry = new CommunicatorRegistry();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const own = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const close = vi.fn();
    registry.register({ id, host_id: 42, username: 'fixture', version: '0.9.78', connected_at: new Date().toISOString(), sessions: 0, requests: 0, synced_at: null }, {
      close, remoteAddress: null, send: (value: unknown) => {
        const command = value as { request_id: string; owner_instance_id: string };
        expect(command.owner_instance_id).toBe(own);
        registry.acknowledgeTerminate(id, command.request_id, { accepted: true, pid: 1234, reason: null, instance_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
      },
    });
    registry.setCapabilities(id, { terminate: true, pid: 1234, started_at: null, instance_id: own, runtime_id: 'aaaaaaaaaaaaaaaa' });
    const result = await registry.terminate(id, 'fixture', { ackMs: 30, closeMs: 30 });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'owner_mismatch' });
    expect(close).not.toHaveBeenCalled();
    expect(registry.has(id)).toBe(true);
    expect(registry.get(id)?.closing).toBe(false);
  });

  it('does not report process termination from an ACK and transport close while the reported process is alive', async () => {
    const registry = new CommunicatorRegistry();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    registry.register({
      id, host_id: 42, username: 'fixture', version: '0.9.76',
      connected_at: new Date().toISOString(), sessions: 0, requests: 0, synced_at: null,
    }, {
      close: vi.fn(), remoteAddress: null,
      send: (value: unknown) => {
        const command = value as { request_id: string };
        // This fixture ACKs and closes ONLY the registry's transport. It never
        // signals a process. The announced PID remains the live Vitest worker.
        registry.acknowledgeTerminate(id, command.request_id, { accepted: true, pid: process.pid, reason: null, instance_id: id });
        queueMicrotask(() => registry.unregister(id));
      },
    });
    registry.setCapabilities(id, { terminate: true, pid: process.pid, started_at: new Date().toISOString(), instance_id: id, runtime_id: 'aaaaaaaaaaaaaaaa' });
    const outcome = await registry.terminate(id, 'fixture', { ackMs: 30, closeMs: 30 });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    console.info('transport-only termination result with live PID', outcome);
    expect(outcome).toMatchObject({ outcome: 'acknowledged_closed', pid: process.pid });
    expect(outcome.outcome).not.toBe('terminated');
  });
});
