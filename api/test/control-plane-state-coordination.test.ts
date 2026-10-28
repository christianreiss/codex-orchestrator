import { resumeNativeFixture } from './helpers/native-resume.js';
import { mutateOwnerState } from '../src/control-plane/state/runtime.js';
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
function setup(beforeCommit: () => Promise<void> = async () => {}) {
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
        heartbeatAt: now,
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
      async record(_tx, receipt) { if (receipt.kind === 'coordination.claim.status') await beforeCommit(); },
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
      resources: [{ kind: 'path', path: '/repo' }],
    });
    expect(result.resources).toEqual([{kind:'path',host_id:1,path:'/repo'}]);
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
    await expect(h.service.claims.status(h.sessionId, h.token, { claim_id: result.id, renew: true })).rejects.toThrow('Only the original connected owner');
    expect(h.state.snapshot().claims.get(result.id)?.state).toBe('uncertain');
    expect(h.select).not.toHaveBeenCalled();
  });
  describe('ended owners', () => {
    const endSession = (h: ReturnType<typeof setup>) => {
      const draft = h.state.begin(), revision = h.state.revision();
      draft.upsert('agentSessions', { ...draft.table('agentSessions').get(h.sessionId)!, endedAt: new Date().toISOString() });
      h.state.publish(draft.seal({ ...revision, sequence: revision.sequence + 1n }));
    };
    const claimed = async (h: ReturnType<typeof setup>) => {
      const claim = await h.service.claims.acquire(h.sessionId, h.token, {
        client_request_id: randomUUID(),
        purpose: 'abandoned operation',
        resources: [{ kind: 'path', host_id: 1, path: '/repo' }],
      });
      h.live.detach();
      await h.service.reconcileOwned();
      expect(h.state.snapshot().claims.get(claim.id)?.state).toBe('uncertain');
      return claim;
    };
    it('keeps a disconnected claim of a session that is still alive uncertain', async () => {
      const h = setup(), claim = await claimed(h);
      await h.service.reconcileOwned();
      expect(h.state.snapshot().claims.get(claim.id)).toMatchObject({ state: 'uncertain', uncertaintyReason: 'disconnected' });
    });
    it('releases the uncertain claim once its session has ended, without an operator', async () => {
      const h = setup(), claim = await claimed(h);
      endSession(h);
      await h.service.reconcileOwned();
      expect(h.state.snapshot().claims.get(claim.id)).toMatchObject({ state: 'released', uncertaintyReason: null });
      const blockers = h.state.snapshot().claims.all().filter((row) => ['active', 'uncertain'].includes(row.state));
      expect(blockers).toEqual([]);
    });
    it('releases an active claim of an ended session in two steps (uncertain, then released)', async () => {
      const h = setup();
      const claim = await h.service.claims.acquire(h.sessionId, h.token, {
        client_request_id: randomUUID(),
        purpose: 'ended while active',
        resources: [{ kind: 'path', host_id: 1, path: '/repo' }],
      });
      endSession(h);
      await h.service.reconcileOwned();
      await h.service.reconcileOwned();
      expect(h.state.snapshot().claims.get(claim.id)?.state).toBe('released');
    });
    it('keeps the claim while a live successor on the same transcript can still continue it', async () => {
      const h = setup(), claim = await claimed(h);
      const next = await resumeNativeFixture(h.owner, h.presence, h.sessionId);
      await h.service.reconcileOwned();
      expect(h.state.snapshot().claims.get(claim.id)).toMatchObject({ state: 'uncertain', sessionId: h.sessionId });
      await h.service.claims.status(next.id, next.token, { claim_id: claim.id, renew: true });
      expect(h.state.snapshot().claims.get(claim.id)).toMatchObject({ state: 'active', sessionId: next.id });
    });
    it('never releases an outcome the owner reported as unknown, even after the session ended', async () => {
      const h = setup(), claim = await claimed(h);
      const draft = h.state.begin(), revision = h.state.revision();
      draft.upsert('agentResourceClaims', { ...draft.table('agentResourceClaims').get(claim.id)!, uncertaintyReason: 'reported_unknown' });
      h.state.publish(draft.seal({ ...revision, sequence: revision.sequence + 1n }));
      endSession(h);
      await h.service.reconcileOwned();
      expect(h.state.snapshot().claims.get(claim.id)).toMatchObject({ state: 'uncertain', uncertaintyReason: 'reported_unknown' });
    });
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


describe('explicit same-transcript claim continuation', () => {
  it('rejects attachment replacement while recovery persistence is in flight', async () => {
    let armed = false, entered!: () => void, finish!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const h = setup(async () => { if (armed) { entered(); await gate; } });
    const claim = await h.service.claims.acquire(h.sessionId, h.token, { client_request_id: randomUUID(), purpose: 'commit fence', resources: [{ kind: 'path', host_id: 1, path: '/repo' }] });
    h.live.detach(); await h.service.reconcileOwned();
    const next = await resumeNativeFixture(h.owner, h.presence, h.sessionId);
    armed = true;
    const recovery = h.service.claims.status(next.id, next.token, { claim_id: claim.id, renew: true });
    await blocked;
    next.live.detach();
    h.presence.attach({ connectionId: randomUUID(), hostId: 1, username: 'root', scope: { topic: 'session', session_id: next.id, binding_generation: 3, native_instance_id: randomUUID() } });
    finish();
    await expect(recovery).rejects.toThrow('Original native connection');
    expect(h.state.snapshot().claims.get(claim.id)?.sessionId).toBe(h.sessionId);
  });

  it('serializes duplicate recovery into one transfer and one durable audit', async () => {
    const h = setup();
    const claim = await h.service.claims.acquire(h.sessionId, h.token, { client_request_id: randomUUID(), purpose: 'parallel recovery', resources: [{ kind: 'path', host_id: 1, path: '/repo' }] });
    h.live.detach(); await h.service.reconcileOwned();
    const next = await resumeNativeFixture(h.owner, h.presence, h.sessionId);
    const results = await Promise.all([1, 2].map(() => h.service.claims.status(next.id, next.token, { claim_id: claim.id, renew: true })));
    expect(results.every(result => result.state === 'active' && result.session_id === next.id)).toBe(true);
    expect(h.fake.tables.get(schema.logs)?.filter(row => row.action === 'resource_claim.resumed')).toHaveLength(1);
  });
  it('does not recover an operator-unknown outcome committed before recovery admission', async () => {
    const h = setup();
    const claim = await h.service.claims.acquire(h.sessionId, h.token, { client_request_id: randomUUID(), purpose: 'raced unknown outcome', resources: [{ kind: 'path', host_id: 1, path: '/repo' }] });
    h.live.detach(); await h.service.reconcileOwned();
    const next = await resumeNativeFixture(h.owner, h.presence, h.sessionId);
    const unknown = h.service.claims.release(null, null, { claim_id: claim.id, outcome: 'unknown', reason: 'Operator cannot establish outcome' }, 1);
    const recovery = h.service.claims.status(next.id, next.token, { claim_id: claim.id, renew: true });
    const results = await Promise.allSettled([unknown, recovery]);
    expect(results[0].status).toBe('fulfilled'); expect(results[1].status).toBe('rejected');
    expect(h.state.snapshot().claims.get(claim.id)).toMatchObject({ sessionId: h.sessionId, state: 'uncertain', uncertaintyReason: 'reported_unknown' });
  });

  it.each(['same', 'foreign-transcript', 'old-running', 'unknown-outcome', 'foreign-user'])('recovers only proven completed original lifecycle (%s)', async (scenario) => {
    const h = setup();
    const claim = await h.service.claims.acquire(h.sessionId, h.token, { client_request_id: randomUUID(), purpose: 'continue fixture', resources: [{ kind: 'path', host_id: 1, path: '/repo' }] });
    h.live.detach(); await h.service.reconcileOwned();
    const next = await resumeNativeFixture(h.owner, h.presence, h.sessionId);
    await mutateOwnerState(h.owner, { kind: 'test.resume-scenario', payload: {}, prepare(ctx) {
      if (scenario === 'foreign-transcript') ctx.draft.upsert('agentSessions', { ...ctx.snapshot.sessions.get(next.id)!, upstreamSessionId: randomUUID() });
      if (scenario === 'foreign-user') ctx.draft.upsert('agentSessions', { ...ctx.snapshot.sessions.get(h.sessionId)!, username: 'somebody-else' });
      if (scenario === 'old-running') ctx.draft.upsert('agentSessions', { ...ctx.snapshot.sessions.get(h.sessionId)!, endedAt: null, status: 'running' });
      if (scenario === 'unknown-outcome') ctx.draft.upsert('agentResourceClaims', { ...ctx.snapshot.claims.get(claim.id)!, uncertaintyReason: 'reported_unknown' });
      return null;
    } });
    await expect(h.service.claims.status(next.id, next.token, { claim_id: claim.id })).rejects.toThrow('another session');
    const recover = () => h.service.claims.status(next.id, next.token, { claim_id: claim.id, renew: true });
    if (scenario === 'same') {
      await expect(h.service.claims.release(next.id, next.token, { claim_id: claim.id, outcome: 'completed', reason: 'continued operation ended' })).rejects.toMatchObject({
        code: 'claim_owner_uncertain',
        message: expect.stringContaining('resource_claim_status({claim_id,renew:true})'),
      });
      expect(await recover()).toMatchObject({ id: claim.id, session_id: next.id, state: 'active', expires_at: null });
      expect(h.state.snapshot().claims.get(claim.id)?.nativeInstanceId).toBe(next.instance);
      await expect(h.service.claims.release(h.sessionId, h.token, { claim_id: claim.id, outcome: 'completed', reason: 'stale owner' })).rejects.toThrow();
      await expect(h.service.claims.release(next.id, next.token, { claim_id: claim.id, outcome: 'completed', reason: 'continued operation ended' })).resolves.toMatchObject({ state: 'released' });
    } else {
      await expect(recover()).rejects.toThrow();
      expect(h.state.snapshot().claims.get(claim.id)?.sessionId).toBe(h.sessionId);
    }
  });
});

describe('offline owners', () => {
  const GRACE = 5 * 60_000;
  const edit = (h: ReturnType<typeof setup>, apply: (draft: ReturnType<typeof h.state.begin>) => void) => {
    const draft = h.state.begin(), revision = h.state.revision();
    apply(draft);
    h.state.publish(draft.seal({ ...revision, sequence: revision.sequence + 1n }));
  };
  const disconnected = async (h: ReturnType<typeof setup>) => {
    const claim = await h.service.claims.acquire(h.sessionId, h.token, {
      client_request_id: randomUUID(),
      purpose: 'operation of an agent that goes offline',
      resources: [{ kind: 'path', host_id: 1, path: '/repo' }],
    });
    h.live.detach();
    await h.service.reconcileOwned();
    expect(h.state.snapshot().claims.get(claim.id)?.state).toBe('uncertain');
    return claim;
  };
  it('keeps a disconnected claim through the reconnect grace and releases it after, without the session ending', async () => {
    const h = setup(), claim = await disconnected(h);
    await h.service.reconcileOwned(Date.now() + GRACE - 30_000);
    expect(h.state.snapshot().claims.get(claim.id)).toMatchObject({ state: 'uncertain', uncertaintyReason: 'disconnected' });
    await h.service.reconcileOwned(Date.now() + GRACE + 30_000);
    expect(h.state.snapshot().claims.get(claim.id)).toMatchObject({ state: 'released', uncertaintyReason: null });
    expect(h.state.snapshot().sessions.get(h.sessionId)?.endedAt).toBeNull();
  });
  it('never releases the claim of an owner that reconnected, however long ago it first dropped', async () => {
    const h = setup(), claim = await disconnected(h);
    h.attach();
    await h.service.reconcileOwned(Date.now() + 10 * GRACE);
    expect(h.state.snapshot().claims.get(claim.id)?.state).toBe('uncertain');
  });
  it('releases a waiting claim of a holder that is gone', async () => {
    const h = setup(), claim = await disconnected(h);
    edit(h, (draft) => draft.upsert('agentResourceClaims', { ...draft.table('agentResourceClaims').get(claim.id)!, state: 'waiting', uncertaintyReason: null }));
    await h.service.reconcileOwned(Date.now() + GRACE + 30_000);
    expect(h.state.snapshot().claims.get(claim.id)?.state).toBe('released');
  });
  it('keeps a reported-unknown outcome for an operator even when the owner is long gone', async () => {
    const h = setup(), claim = await disconnected(h);
    edit(h, (draft) => draft.upsert('agentResourceClaims', { ...draft.table('agentResourceClaims').get(claim.id)!, uncertaintyReason: 'reported_unknown' }));
    await h.service.reconcileOwned(Date.now() + 100 * GRACE);
    expect(h.state.snapshot().claims.get(claim.id)).toMatchObject({ state: 'uncertain', uncertaintyReason: 'reported_unknown' });
  });
  it('finalizes a crashed session as abandoned once its bridge lapsed and releases its claims in the same commit', async () => {
    const h = setup(), claim = await disconnected(h);
    const ttl = loadTestEnv().AGENT_PORTAL_BRIDGE_TTL_SECONDS * 1000;
    edit(h, (draft) => draft.upsert('agentSessions', { ...draft.table('agentSessions').get(h.sessionId)!, bridgeExpiresAt: new Date(Date.now() - 1000).toISOString() }));
    await h.service.reconcileOwned(Date.now() + ttl - 60_000);
    expect(h.state.snapshot().sessions.get(h.sessionId)?.endedAt).toBeNull();
    await h.service.reconcileOwned(Date.now() + ttl + 60_000);
    const session = h.state.snapshot().sessions.get(h.sessionId)!;
    expect(session.endedAt).not.toBeNull();
    expect(session.status).toBe('failed');
    expect(h.state.snapshot().claims.get(claim.id)?.state).toBe('released');
  });
  it('gives an interactive session that advertises suspend recovery a day before finalizing it', async () => {
    const h = setup();
    const ttl = loadTestEnv().AGENT_PORTAL_BRIDGE_TTL_SECONDS * 1000;
    h.live.detach();
    edit(h, (draft) => draft.upsert('agentSessions', {
      ...draft.table('agentSessions').get(h.sessionId)!,
      invocationKind: 'interactive',
      adapterCapabilities: { scope_protocol_version: 1, suspend_recovery_version: 1 },
      bridgeExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    await h.service.reconcileOwned(Date.now() + ttl + 60_000);
    expect(h.state.snapshot().sessions.get(h.sessionId)?.endedAt).toBeNull();
    await h.service.reconcileOwned(Date.now() + 25 * 3600_000);
    expect(h.state.snapshot().sessions.get(h.sessionId)?.endedAt).not.toBeNull();
  });
  it('restamps a connected session last-seen so it survives an API restart, and leaves a fresh one alone', async () => {
    const h = setup();
    await h.service.reconcileOwned();
    const before = h.state.snapshot().sessions.get(h.sessionId)!.heartbeatAt;
    const command = vi.spyOn(h.owner, 'execute');
    await h.service.reconcileOwned(Date.now() + 60_000);
    expect(command).not.toHaveBeenCalled();
    const later = Date.now() + 11 * 60_000;
    await h.service.reconcileOwned(later);
    const after = h.state.snapshot().sessions.get(h.sessionId)!.heartbeatAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    expect(Date.parse(after)).toBe(later);
  });
});
