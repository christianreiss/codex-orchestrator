import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { agentSessions, type AgentBusAddress } from '../../../src/db/schema.js';
import { CallCoordinator, type CallCore } from '../../../src/services/agent-messaging/call.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';

function fixture(engine: 'codex' | 'claude') {
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    heartbeatAt: now,
    endedAt: null,
    receiver: null as unknown,
  };
  const address = {
    id: randomUUID(),
    address: `agent:${randomUUID()}`,
    engine,
    enabled: 1,
    readiness: 'resumable',
    archivedAt: null,
    currentSessionId: session.id,
    lastUpstreamSessionId: null,
    receiveHeartbeatAt: null,
    callPin: '0126',
    callPinExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  } as AgentBusAddress;
  const db = createDbFake(new Map([[agentSessions, [session]]]));
  const core: CallCore = {
    db: db as unknown as Database,
    keyring: testKeyring(),
    presenceFreshSeconds: 120,
    authenticateBridge: vi.fn().mockResolvedValue({
      session: { ...session, agentBusAddressId: address.id },
      host: {},
    }),
    requireEnabledLocked: vi.fn().mockResolvedValue(undefined),
    requireAddressLocked: vi.fn().mockResolvedValue(address),
    assertSessionAddressLocked: vi.fn().mockResolvedValue(undefined),
    assertAddressEligibleLocked: vi.fn().mockResolvedValue(undefined),
    recordRuntime: vi.fn().mockResolvedValue(undefined),
  };
  return { call: new CallCoordinator(core), session, address };
}

describe.each(['codex', 'claude'] as const)('%s call readiness', (engine) => {
  it('keeps an existing PIN and refreshes its reported presence when reception changes', async () => {
    const { call, session, address } = fixture(engine);
    const open = () => call.openCall(session.id, 'bridge-token');
    expect(await open()).toMatchObject({
      pin: '0126', reused: true, listening: false, self: { presence: 'online' },
    });

    session.receiver = {
      generation: randomUUID(),
      protocol: engine === 'codex' ? 'codex-queue-v1' : 'claude-channel-v1',
      native_session_id: randomUUID(),
      heartbeat_at: new Date().toISOString(),
      failure: null,
      probes: { peer: {} },
    };
    expect(await open()).toMatchObject({
      pin: '0126', reused: true, listening: true, self: { presence: 'listening' },
    });
    expect(address.callPin).toBe('0126');
  });

  it('does not call a failed native receiver listening despite a fresh legacy heartbeat', async () => {
    const { call, session, address } = fixture(engine);
    address.receiveHeartbeatAt = new Date().toISOString();
    session.receiver = {
      generation: randomUUID(),
      heartbeat_at: new Date().toISOString(),
      failure: 'adapter_disconnected',
      probes: { peer: {} },
    };
    expect(await call.openCall(session.id, 'bridge-token')).toMatchObject({
      listening: false, self: { presence: 'online' },
    });
  });

  it('reports a removed session binding as offline while retaining the PIN', async () => {
    const { call, session, address } = fixture(engine);
    address.currentSessionId = null;
    expect(await call.openCall(session.id, 'bridge-token')).toMatchObject({
      pin: '0126', reused: true, listening: false, self: { presence: 'offline' },
    });
  });
});
