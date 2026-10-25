import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { ScopeSession } from '../../../src/control-plane/state/coordination.js';
import { claimConnectionError } from '../../../src/services/agent-coordination/claim-connection-error.js';

describe.each(['codex', 'claude', 'grok'])('%s claim connection diagnostics', (engine) => {
  it.each(['missing', 'no-native', 'wrong-instance', 'connected', 'foreign', 'old-generation'] as const)(
    'reports only caller proof for %s without changing ownership',
    (proof) => {
      const session = {
        id: randomUUID(),
        hostId: 245,
        username: 'user',
        engine,
        bindingGeneration: 7,
        upstreamSessionId: 'native-transcript',
        bridgeTokenHash: 'secret-bridge-sentinel',
      } as ScopeSession;
      const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
        hosts: [{ id: 245, fqdn: 'fixture.test', apiKey: 'secret-host-sentinel' }],
        agentSessions: [session],
      } as unknown as StateSeed);
      const owner = { assertOwner() {} } as OwnerRuntime;
      const presence = new ConnectionPresence((error) => {
        throw error;
      });
      bindOwnerPresence(owner, presence);
      const expected = randomUUID(),
        foreignSession = randomUUID();
      if (proof !== 'missing')
        presence.attach({
          connectionId: randomUUID(),
          hostId: 245,
          username: 'user',
          scope: {
            topic: 'session',
            session_id: proof === 'foreign' ? foreignSession : session.id,
            binding_generation: proof === 'old-generation' ? 6 : 7,
            ...(proof === 'no-native'
              ? {}
              : { native_instance_id: proof === 'connected' ? expected : randomUUID() }),
          },
        });
      const error = claimConnectionError(owner, snapshot, session, undefined, expected);
      expect(error).toMatchObject({
        status: 409,
        code: 'claim_connection_required',
        extra: {
          claim_connection: {
            session_id: session.id,
            host_id: 245,
            fqdn: 'fixture.test',
            binding_generation: 7,
            engine,
            native_session_bound: true,
            proof_state: ['missing', 'foreign', 'old-generation'].includes(proof)
              ? 'session_attachment_missing'
              : proof === 'no-native'
                ? 'native_instance_missing'
                : proof === 'wrong-instance'
                  ? 'original_native_instance_missing'
                  : 'native_connection_present',
            original_native_connection_present: proof === 'connected',
          },
        },
      });
      expect(error.message).toContain('cxx communicator status');
      expect(error.message).toContain('doctor');
      const details = JSON.stringify(error.extra);
      expect(details).toContain('cxx communicator status');
      expect(details).toContain(`${engine === 'codex' ? 'cdx' : engine === 'claude' ? 'clx' : 'cgx'} doctor`);
      expect(details).toContain('same client_request_id');
      expect(details).toContain('Do not take over');
      for (const secret of ['secret-host-sentinel', 'secret-bridge-sentinel', expected, foreignSession])
        expect(details).not.toContain(secret);
      expect(snapshot.table('agentResourceClaims').all()).toEqual([]);
      presence.close();
    },
  );
});
