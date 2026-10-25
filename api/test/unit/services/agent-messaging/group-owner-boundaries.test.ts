import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AgentMessagingGroups } from '../../../../src/services/agent-messaging/groups.js';
import { ownedAddress } from '../../../../src/control-plane/state/messaging.js';
import { ForbiddenError } from '../../../../src/http/errors.js';
import { createDbFake } from '../../../helpers/db-fake.js';
import { testKeyring } from '../../../helpers/test-keyring.js';
import { OwnerStateSnapshot } from '../../../../src/control-plane/state/store.js';
import {
  assertOwnerRequestAuthority,
  bindOwnerRuntime,
  finalizeOwnerResponse,
  withOwnerRequestScope,
  type OwnerRuntime,
} from '../../../../src/control-plane/state/runtime.js';
import { sha256 } from '../../../../src/security/hash.js';
import type { AgentBusAddress } from '../../../../src/db/schema.js';

function fixture(engine: string, hostChanges: Record<string, unknown>) {
  const sender = { id: randomUUID(), hostId: 1, enabled: 1, engine: 'codex' } as AgentBusAddress;
  const healthy = { id: randomUUID(), hostId: 2, enabled: 1, engine } as AgentBusAddress;
  const unavailable = { id: randomUUID(), hostId: 3, enabled: 1, engine } as AgentBusAddress;
  const addresses = new Map([sender, healthy, unavailable].map((row) => [row.id, row]));
  const rows: Record<string, unknown[]> = {
    agentBusGroups: [{ id: randomUUID(), slug: 'boundary' }],
    agentBusSubscriptions: [sender, healthy, unavailable].map((row) => ({
      id: randomUUID(),
      topic: 'group:boundary',
      subscriberAddressId: row.id,
    })),
  };
  const snapshot = {
    addresses,
    setting: () => null,
    hosts: new Map([
      [2, { id: 2, status: 'active', secure: 1, engines: engine }],
      [3, { id: 3, status: 'active', secure: 1, engines: engine, ...hostChanges }],
    ]),
    table: (name: string) => ({ all: () => rows[name] ?? [] }),
  } as unknown as OwnerStateSnapshot;
  const db = createDbFake();
  const eligible = vi.fn(async (_tx: unknown, address: AgentBusAddress) => {
    ownedAddress(snapshot, address.id);
  });
  const groups = new AgentMessagingGroups({
    db,
    keyring: testKeyring(),
    requireAddressLocked: async (_tx: unknown, id: string) => addresses.get(id)!,
    assertAddressEligibleLocked: eligible,
  } as unknown as ConstructorParameters<typeof AgentMessagingGroups>[0]);
  const internals = groups as unknown as {
    snapshot(): OwnerStateSnapshot;
    managed(): Promise<undefined>;
    publish(
      tx: unknown,
      actor: AgentBusAddress,
      session: null,
      input: unknown,
    ): Promise<{
      recipient_count: number;
      deliveries: { address_id: string }[];
      skipped: { address_id: string; reason: string }[];
    }>;
  };
  vi.spyOn(internals, 'snapshot').mockReturnValue(snapshot);
  vi.spyOn(internals, 'managed').mockResolvedValue(undefined);
  return { internals, db, sender, healthy, unavailable, eligible };
}

describe('owned publication recipient eligibility', () => {
  for (const engine of ['codex', 'claude', 'grok']) {
    for (const [reason, host] of [
      ['inactive', { status: 'inactive' }],
      ['expired', { expiresAt: '2000-01-01T00:00:00Z' }],
      ['closed insecure window', { secure: 0, insecureEnabledUntil: null }],
    ] as const) {
      it(`skips ${engine} ${reason} recipients without blocking healthy subscribers`, async () => {
        const f = fixture(engine, host);
        const result = await f.internals.publish(f.db, f.sender, null, {
          topic: 'group:boundary',
          content: 'one healthy recipient',
          clientMessageId: randomUUID(),
        });
        expect(result.recipient_count).toBe(1);
        expect(result.deliveries).toEqual([expect.objectContaining({ address_id: f.healthy.id })]);
        expect(result.skipped).toContainEqual({ address_id: f.unavailable.id, reason: 'address_ineligible' });
      });
    }
  }
  it('propagates unrelated authorization failures', async () => {
    const f = fixture('grok', {});
    const error = new ForbiddenError('owner authority revoked', 'unrelated_authority');
    f.eligible.mockRejectedValue(error);
    await expect(
      f.internals.publish(f.db, f.sender, null, {
        topic: 'group:boundary',
        content: 'must fail closed',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toBe(error);
  });
});

describe('group metadata response authorization', () => {
  for (const engine of ['codex', 'claude', 'grok']) {
    function setup() {
      const db = createDbFake(),
        sessionId = randomUUID(),
        addressId = randomUUID();
      const seed = (endedAt: string | null) => ({
        versions: [{ name: 'agent_messaging_enabled', version: '1' }],
        hosts: [{ id: 1, status: 'active', secure: 1, engines: engine, apiKey: 'fixture' }],
        agentSessions: [
          {
            id: sessionId,
            hostId: 1,
            engine,
            endedAt,
            bindingGeneration: 1,
            agentBusAddressId: addressId,
            bridgeTokenHash: sha256('bridge'),
            hostAuthFingerprint: sha256('fixture'),
            bridgeExpiresAt: '2099-01-01T00:00:00Z',
          },
        ],
        agentBusAddresses: [
          {
            id: addressId,
            hostId: 1,
            engine,
            enabled: 1,
            archivedAt: null,
            currentSessionId: sessionId,
            bindingGeneration: 1,
          },
        ],
      });
      const snapshot = (endedAt: string | null) =>
        new OwnerStateSnapshot(
          { epoch: '00000000-0000-4000-8000-000000000001', sequence: 0n },
          seed(endedAt) as unknown as ConstructorParameters<typeof OwnerStateSnapshot>[1],
        );
      let current = snapshot(null);
      const runtime = { state: { snapshot: () => current }, assertOwner() {} } as unknown as OwnerRuntime;
      bindOwnerRuntime(db, runtime);
      const groups = new AgentMessagingGroups({ db } as unknown as ConstructorParameters<
        typeof AgentMessagingGroups
      >[0]);
      return {
        groups,
        sessionId,
        runtime,
        revoke: () => {
          current = snapshot(new Date().toISOString());
        },
      };
    }
    it(`${engine}: rejects revocation during an awaited metadata read`, async () => {
      const f = setup();
      const internals = f.groups as unknown as { list(): Promise<unknown> };
      vi.spyOn(internals, 'list').mockImplementation(async () => {
        await Promise.resolve();
        f.revoke();
        return { groups: ['private metadata'] };
      });
      await expect(f.groups.listForAgent(f.sessionId, 'bridge')).rejects.toMatchObject({
        code: 'agent_session_finished',
      });
    });
    it(`${engine}: rejects revocation at the response boundary`, async () => {
      const f = setup();
      await withOwnerRequestScope(async () => {
        const result = await f.groups.listForAgent(f.sessionId, 'bridge');
        f.revoke();
        expect(() => assertOwnerRequestAuthority()).toThrow();
        expect(() => finalizeOwnerResponse(f.runtime, result)).toThrow();
      });
    });
  }
});
