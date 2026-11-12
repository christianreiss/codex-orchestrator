import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { peekOwnedMailbox } from '../../../src/services/agent-messaging/owned-read.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { sha256 } from '../../../src/security/hash.js';

function fixture(options: { portal?: boolean; active?: number; status?: string; due?: string } = {}) {
  const id = randomUUID(),
    token = 'mailbox-test',
    addressId = randomUUID();
  const seed = {
    versions: [
      { name: 'agent_messaging_enabled', version: '1' },
      { name: 'agent_portal_enabled', version: options.portal === false ? '0' : '1' },
    ],
    hosts: [
      { id: 1, status: 'active', secure: 1, engines: 'kimi', apiKeyHash: 'a'.repeat(64), expiresAt: null },
    ],
    agentSessions: [
      {
        id,
        hostId: 1,
        engine: 'kimi',
        endedAt: null,
        bridgeTokenHash: sha256(token),
        bridgeExpiresAt: '2099-01-01T00:00:00.000Z',
        hostAuthFingerprint: sha256('a'.repeat(64)),
        agentBusAddressId: addressId,
        bindingGeneration: 1,
      },
    ],
    agentBusAddresses: [
      {
        id: addressId,
        hostId: 1,
        engine: 'kimi',
        enabled: 1,
        archivedAt: null,
        currentSessionId: id,
        bindingGeneration: 1,
      },
    ],
    adminUsers: [{ id: 7, name: 'Operator', active: options.active ?? 1 }],
    agentMessages: [
      {
        id: 1,
        sessionId: id,
        messageId: 'portal-command',
        adminUserId: 7,
        status: options.status ?? 'queued',
        nextAttemptAt: options.due ?? '2000-01-01T00:00:00.000Z',
        contentEnc: 'must not be read',
        attempts: 0,
        leaseOwner: null,
      },
    ],
  } as unknown as StateSeed;
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed));
  const execute = vi.fn();
  const runtime = { state, assertOwner() {}, execute } as unknown as OwnerRuntime;
  return { state, execute, peek: () => peekOwnedMailbox(runtime, id, token) };
}

describe('owner portal mailbox ring', () => {
  it('returns only metadata and leaves queue and owner revision untouched', () => {
    const h = fixture(),
      before = h.state.revision(),
      row = h.state.snapshot().table('agentMessages').get(1);
    for (let i = 0; i < 2; i++) {
      expect(h.peek()).toEqual({
        pending: [
          {
            source: 'portal',
            kind: 'portal',
            message_id: 'portal-command',
            from: { address: 'admin:7', alias: 'Operator', engine: 'operator', fqdn: null },
            expires_at: null,
          },
        ],
        missed: [],
      });
    }
    expect(h.state.revision()).toEqual(before);
    expect(h.state.snapshot().table('agentMessages').get(1)).toEqual(row);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it.each([
    { portal: false },
    { active: 0 },
    { status: 'leased' },
    { status: 'accepted' },
    { due: '2099-01-01T00:00:00.000Z' },
  ])('does not ring ineligible Portal commands (%j)', (options) => {
    expect(fixture(options).peek()).toEqual({ pending: [], missed: [] });
  });
});
