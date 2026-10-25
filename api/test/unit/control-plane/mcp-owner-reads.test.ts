import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { scopedDatabase } from '../../../src/db/fresh-read.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import {
  createWorkflowsService,
  registerWorkflowBridgeRoutes,
} from '../../../src/routes/agent-messaging/workflows.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of close.splice(0)) await stop();
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(
  engine = 'codex',
  options: {
    disabled?: boolean;
    stale?: boolean;
    oldWrapper?: boolean;
    expired?: boolean;
    targetDisabled?: boolean;
    engineDisabled?: boolean;
  } = {},
) {
  const id = randomUUID(),
    address = randomUUID(),
    token = 'private-fixture-token';
  const now = new Date().toISOString();
  const seed = {
    versions: [
      { name: 'agent_messaging_enabled', version: options.disabled ? '0' : '1' },
      { name: 'workflows_enabled', version: '1' },
      { name: `${engine}_engine_disabled`, version: options.engineDisabled ? '1' : '0' },
    ],
    hosts: [
      {
        id: 1,
        fqdn: 'fixture',
        status: 'active',
        secure: 1,
        engines: 'codex,claude,grok',
        apiKey: 'fixture-host',
        expiresAt: null,
        insecureEnabledUntil: null,
        wrapperVersion: options.oldWrapper ? '0.1.0' : '0.9.129',
      },
    ],
    agentSessions: [
      {
        id,
        hostId: 1,
        username: 'fixture',
        engine,
        endedAt: null,
        expiresAt: null,
        agentBusAddressId: address,
        bindingGeneration: 1,
        bridgeTokenHash: hash(token),
        hostAuthFingerprint: hash('fixture-host'),
        bridgeExpiresAt: new Date(Date.now() + (options.expired ? -60_000 : 60_000)).toISOString(),
        launchName: 'Fixture',
        adapterCapabilities: { workflow_protocol_version: 2 },
      },
    ],
    agentBusAddresses: [
      {
        id: address,
        hostId: 1,
        engine,
        address: `agent:${address}`,
        enabled: options.targetDisabled ? 0 : 1,
        archivedAt: null,
        currentSessionId: id,
        bindingGeneration: options.stale ? 2 : 1,
        launchName: 'Fixture',
      },
    ],
    agentNamePool: [{ nameKey: 'fixture', name: 'Fixture', currentSessionId: id }],
    agentNameLeases: [
      {
        id: 1,
        sessionId: id,
        addressId: address,
        name: 'Fixture',
        nameKey: 'fixture',
        startedAt: now,
        endedAt: null,
        cooldownUntil: null,
      },
    ],
  };
  const raw = {
    select: vi.fn(() => {
      throw new Error('Unexpected SQL read');
    }),
    transaction: vi.fn(() => {
      throw new Error('Unexpected SQL transaction');
    }),
  };
  const db = scopedDatabase(raw) as unknown as Database;
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  close.push(() => deadlines.close());
  const owner: OwnerRuntime = {
    state: new OwnerStateStore(
      new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
    ),
    deadlines,
    assertOwner() {},
    execute: vi.fn(async () => {
      throw new Error('Unexpected owner write');
    }),
  };
  bindOwnerRuntime(db, owner);
  const ctx = { db, env: loadTestEnv(), keyring: testKeyring() };
  return {
    id,
    address,
    token,
    raw,
    owner,
    ctx,
    messaging: new AgentMessagingService(db, ctx.env, ctx.keyring),
  };
}

describe('native MCP owner reads', () => {
  it.each(['codex', 'claude', 'grok'])(
    'translates %s names and UUIDs without any SQL or writer',
    async (engine) => {
      const f = fixture(engine);
      for (const value of ['Fixture', f.address, `agent:${f.address}`]) {
        await expect(f.messaging.translate(value, f.id, f.token)).resolves.toMatchObject({
          uuid: f.address,
          name: 'Fixture',
          status: 'active',
        });
      }
      expect(f.raw.select).not.toHaveBeenCalled();
      expect(f.raw.transaction).not.toHaveBeenCalled();
      expect(f.owner.execute).not.toHaveBeenCalled();
    },
  );

  it('preserves enable, bridge and target eligibility checks in translation', async () => {
    const disabled = fixture('codex', { disabled: true });
    await expect(disabled.messaging.translate('Fixture')).rejects.toMatchObject({
      code: 'agent_messaging_disabled',
    });
    const f = fixture();
    await expect(f.messaging.translate('Fixture', f.id, 'wrong')).rejects.toMatchObject({
      code: 'agent_bridge_unauthorized',
    });
    await expect(f.messaging.translate(randomUUID(), f.id, f.token)).rejects.toMatchObject({
      code: 'agent_name_not_found',
    });
    const expired = fixture('codex', { expired: true });
    await expect(expired.messaging.translate('Fixture', expired.id, expired.token)).rejects.toMatchObject({
      code: 'agent_bridge_expired',
    });
    for (const options of [{ targetDisabled: true }, { engineDisabled: true }]) {
      const hidden = fixture('codex', options);
      await expect(hidden.messaging.translate('Fixture')).rejects.toMatchObject({
        code: 'agent_messaging_address_not_found',
      });
    }
  });

  it.each(['codex', 'claude', 'grok'])(
    'reads %s workflow memberships through the real owner-aware route without SQL',
    async (engine) => {
      const f = fixture(engine);
      const app = await buildRouteApp();
      close.push(() => app.close());
      registerWorkflowBridgeRoutes(app, createWorkflowsService(f.ctx, f.messaging), f.messaging);
      const reply = await app.inject({
        method: 'POST',
        url: `/host/agent-sessions/${f.id}/agent-messaging/workflows/run-current`,
        headers: { 'x-agent-bridge-token': f.token },
        payload: {},
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ runs: [], invitations: [], claims: [] });
      expect(f.raw.select).not.toHaveBeenCalled();
      expect(f.raw.transaction).not.toHaveBeenCalled();
      expect(f.owner.execute).not.toHaveBeenCalled();
    },
  );

  it.each([{ stale: true }, { oldWrapper: true }, { disabled: true }, { expired: true }])(
    'refuses fenced workflow reads: %j',
    async (options) => {
      const f = fixture('codex', options);
      const app = await buildRouteApp();
      close.push(() => app.close());
      registerWorkflowBridgeRoutes(app, createWorkflowsService(f.ctx, f.messaging), f.messaging);
      const reply = await app.inject({
        method: 'POST',
        url: `/host/agent-sessions/${f.id}/agent-messaging/workflows/run-current`,
        headers: { 'x-agent-bridge-token': f.token },
        payload: {},
      });
      expect([401, 403, 409, 503]).toContain(reply.statusCode);
      expect(f.raw.select).not.toHaveBeenCalled();
      expect(f.raw.transaction).not.toHaveBeenCalled();
    },
  );
});
