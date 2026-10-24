import { captureLegacyDrainManifest, LegacyDrainRegistry } from '../src/control-plane/legacy-drain.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../src/db/schema.js';
import type { Database } from '../src/db/client.js';
import type { StateSeed } from '../src/control-plane/state/catalog.js';
import { CommandExecutor } from '../src/control-plane/commands.js';
import type { PersistenceTransaction } from '../src/control-plane/persistence.js';
import { DeadlineQueue } from '../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../src/control-plane/presence.js';
import {
  OwnerStateStore,
  OwnerStateSnapshot,
  type PreparedOwnerState,
} from '../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../src/control-plane/state/runtime.js';
import { AgentCoordination } from '../src/services/agent-coordination/index.js';
import type { AgentMessagingService } from '../src/services/agent-messaging.js';
import { sha256 } from '../src/security/hash.js';
import { createDbFake } from './helpers/db-fake.js';
import { loadTestEnv, testKeyring } from './helpers/test-keyring.js';

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
function setup() {
  const sessionId = randomUUID(),
    addressId = randomUUID(),
    instance = randomUUID(),
    now = new Date().toISOString(),
    key = 'owner-coordination-host',
    token = 'bridge-proof';
  const seed = {
    hosts: [
      {
        id: 1,
        fqdn: 'owner.test',
        apiKey: key,
        apiKeyHash: null,
        status: 'active',
        secure: 1,
        engines: 'codex',
        internalRole: null,
        expiresAt: null,
      },
    ],
    versions: [
      { name: 'agent_messaging_enabled', version: '1', updatedAt: now },
      { name: 'agent_coordination_enabled', version: '1', updatedAt: now },
    ],
    agentSessions: [
      {
        id: sessionId,
        hostId: 1,
        agentBusAddressId: addressId,
        engine: 'codex',
        username: 'root',
        cwd: '/repo',
        workspace: null,
        launchName: 'Fixture',
        bindingGeneration: 1,
        bridgeTokenHash: sha256(token),
        hostAuthFingerprint: sha256(key),
        bridgeExpiresAt: '2099-01-01T00:00:00Z',
        endedAt: null,
        upstreamSessionId: null,
        adapterCapabilities: { scope_protocol_version: 1 },
      },
    ],
    agentBusAddresses: [
      {
        id: addressId,
        address: `agent:${addressId}`,
        hostId: 1,
        engine: 'codex',
        currentSessionId: sessionId,
        bindingGeneration: 1,
        enabled: 1,
        archivedAt: null,
        launchName: 'Fixture',
      },
    ],
  };
  const fake = createDbFake(
    new Map(
      Object.entries(seed).map(([name, rows]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone(rows),
      ]),
    ),
  );
  const db = fake as unknown as Database,
    select = vi.spyOn(fake, 'select');
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  closers.push(() => deadlines.close());
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(error) {
      throw error;
    },
    committed() {},
    notificationError(error) {
      throw error;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(fake as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const owner: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  bindOwnerRuntime(db, owner);
  const presence = new ConnectionPresence((error) => {
    throw error;
  });
  bindOwnerPresence(owner, presence);
  closers.push(() => presence.close());
  const attach = (native = instance) =>
    presence.attach({
      connectionId: randomUUID(),
      hostId: 1,
      username: 'root',
      scope: { topic: 'session', session_id: sessionId, binding_generation: 1, native_instance_id: native },
    });
  const live = attach();
  const service = new AgentCoordination(db, loadTestEnv(), testKeyring(), {} as AgentMessagingService);
  return { owner, state, select, fake, service, sessionId, token, instance, presence, attach, live };
}
describe('connection-owned coordination claims', () => {
  it('acquires once then answers repeated healthy status and context reads without SQL or commands', async () => {
    const h = setup();
    const result = await h.service.claims.acquire(h.sessionId, h.token, {
      client_request_id: randomUUID(),
      purpose: 'edit owner fixture',
      resources: [{ kind: 'path', host_id: 1, path: '/repo' }],
    });
    expect(result.state).toBe('active');
    expect(result.expires_at).toBeNull();
    const command = vi.spyOn(h.owner, 'execute');
    for (let index = 0; index < 10; index++)
      await h.service.claims.status(h.sessionId, h.token, { claim_id: result.id, renew: true });
    const context = await h.service.context(h.sessionId, h.token);
    expect(context.rooms).toHaveLength(2);
    expect(command).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
  });
  it('retains disconnected exclusion and recovers only exact native process proof', async () => {
    const h = setup();
    const result = await h.service.claims.acquire(h.sessionId, h.token, {
      client_request_id: randomUUID(),
      purpose: 'active operation',
      resources: [{ kind: 'path', host_id: 1, path: '/repo' }],
    });
    h.live.detach();
    await h.service.reconcileOwned();
    expect(h.state.snapshot().claims.get(result.id)?.state).toBe('uncertain');
    const wrong = h.attach(randomUUID());
    await expect(
      h.service.claims.status(h.sessionId, h.token, { claim_id: result.id, renew: true }),
    ).rejects.toThrow('Original native connection');
    wrong.detach();
    const same = h.attach();
    h.presence.update(same.attachment.id, { active_claim_ids: [result.id] });
    await h.service.reconcileOwned();
    expect(h.state.snapshot().claims.get(result.id)?.state).toBe('active');
    await h.service.claims.release(h.sessionId, h.token, {
      claim_id: result.id,
      outcome: 'unknown',
      reason: 'lost operation outcome',
    });
    await h.service.reconcileOwned();
    expect(h.state.snapshot().claims.get(result.id)?.state).toBe('uncertain');
    expect(h.state.snapshot().claims.get(result.id)?.uncertaintyReason).toBe('reported_unknown');
    await h.service.claims.status(h.sessionId, h.token, { claim_id: result.id, renew: true });
    expect(h.state.snapshot().claims.get(result.id)?.state).toBe('active');
    expect(h.select).not.toHaveBeenCalled();
  });
});

describe('captured timed claim drain', () => {
  async function legacy(captured = true) {
    const h = setup();
    const acquired = await h.service.claims.acquire(h.sessionId,h.token,{client_request_id:randomUUID(),purpose:'cutover operation',resources:[{kind:'path',host_id:1,path:'/repo'}]});
    const edit = (apply: (draft: ReturnType<typeof h.state.begin>) => void) => {
      const draft=h.state.begin(); apply(draft); const revision=h.state.revision();
      h.state.publish(draft.seal({...revision,sequence:revision.sequence+1n}));
    };
    edit(draft => {
      const claim=draft.table('agentResourceClaims').get(acquired.id)!;
      draft.upsert('agentResourceClaims',{...claim,ownershipMode:'timed',nativeInstanceId:null,expiresAt:new Date(Date.now()+60000).toISOString()});
      draft.upsert('agentNativeControls',{sessionId:h.sessionId,instanceId:h.instance,bindingGeneration:1,status:'ready',updatedAt:new Date().toISOString(),requestId:null,clientMessageId:null,actorId:null});
    });
    const manifest=captureLegacyDrainManifest(h.state.snapshot(),Date.now(),{resourceClaimIds:captured?[acquired.id]:[],gitRegistrationIds:[]});
    edit(draft=>draft.upsert('agentResourceClaims',{...draft.table('agentResourceClaims').get(acquired.id)!,state:'uncertain',uncertaintyReason:'owner_restart'}));
    h.live.detach();
    const registry=new LegacyDrainRegistry(h.owner,manifest,{session:60000,relay:60000});closers.push(()=>registry.close());
    return {...h,acquired,edit,registry};
  }
  it('recovers only the captured grant and answers subsequent renewals without writes',async()=>{
    const h=await legacy();
    const before=h.state.snapshot().claims.get(h.acquired.id)!;
    const recovered=await h.service.claims.status(h.sessionId,h.token,{claim_id:before.id,renew:true});
    expect(recovered).toMatchObject({state:'active',ownership_mode:'timed',presence_source:'legacy_drain'});
    expect(recovered.expires_at).not.toBeNull();
    const command=vi.spyOn(h.owner,'execute');
    for(let n=0;n<5;n++)await h.service.claims.status(h.sessionId,h.token,{claim_id:before.id,renew:true});
    expect(command).not.toHaveBeenCalled();expect(h.select).not.toHaveBeenCalled();
    expect(h.state.snapshot().claims.get(before.id)?.expiresAt).toBe(before.expiresAt);
    await expect(h.service.claims.acquire(h.sessionId,h.token,{client_request_id:randomUUID(),purpose:'new legacy claim',resources:[{kind:'path',host_id:1,path:'/other'}]})).rejects.toThrow();
    await h.service.claims.release(h.sessionId,h.token,{claim_id:before.id,outcome:'completed',reason:'operation ended'});
    expect(h.state.snapshot().claims.get(before.id)?.state).toBe('released');
  });
  it('recovers a captured operation after backup exceeds the old grant TTL using fresh exact-process proof',async()=>{
    const h=await legacy(),before=h.state.snapshot().claims.get(h.acquired.id)!;
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+120000);
    try {
      await expect(h.service.claims.status(h.sessionId,h.token,{claim_id:before.id,renew:true})).rejects.toThrow();
      h.registry.renew('session',h.sessionId,h.token,{instanceId:h.instance});
      const result=await h.service.claims.status(h.sessionId,h.token,{claim_id:before.id,renew:true});
      expect(result.state).toBe('active');expect(Date.parse(result.expires_at!)).toBeGreaterThan(Date.now());
      expect(h.state.snapshot().claims.get(before.id)?.expiresAt).toBe(before.expiresAt);
      expect(h.state.snapshot().claims.get(before.id)?.ownershipMode).toBe('timed');
    } finally { clock.mockRestore(); }
  });
  it('does not renew an unknown outcome or survive host revocation',async()=>{
    const h=await legacy();
    h.edit(draft=>draft.upsert('agentResourceClaims',{...draft.table('agentResourceClaims').get(h.acquired.id)!,uncertaintyReason:'reported_unknown'}));
    await expect(h.service.claims.status(h.sessionId,h.token,{claim_id:h.acquired.id,renew:true})).rejects.toThrow();
    expect(h.state.snapshot().claims.get(h.acquired.id)?.state).toBe('uncertain');
    const revoked=await legacy();
    revoked.edit(draft=>draft.upsert('hosts',{...draft.table('hosts').get(1)!,authFingerprint:'revoked'}));
    await expect(revoked.service.claims.status(revoked.sessionId,revoked.token,{claim_id:revoked.acquired.id,renew:true})).rejects.toThrow();
  });
  it('keeps uncaptured uncertain grants excluded and rejects a changed native instance',async()=>{
    const absent=await legacy(false);
    await expect(absent.service.claims.status(absent.sessionId,absent.token,{claim_id:absent.acquired.id,renew:true})).rejects.toThrow();
    expect(absent.state.snapshot().claims.get(absent.acquired.id)?.state).toBe('uncertain');
    const h=await legacy();
    h.edit(draft=>draft.upsert('agentNativeControls',{...draft.table('agentNativeControls').get(h.sessionId)!,instanceId:randomUUID()}));
    await expect(h.service.claims.status(h.sessionId,h.token,{claim_id:h.acquired.id,renew:true})).rejects.toThrow();
    await expect(h.service.claims.release(h.sessionId,h.token,{claim_id:h.acquired.id,outcome:'completed',reason:'not original process'})).rejects.toThrow();
    expect(h.state.snapshot().claims.get(h.acquired.id)?.state).toBe('uncertain');
  });
});
