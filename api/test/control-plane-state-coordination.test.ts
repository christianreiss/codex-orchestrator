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
import { decrypt } from '../src/security/secret-box.js';
import { createDbFake } from './helpers/db-fake.js';
import { loadTestEnv, testKeyring } from './helpers/test-keyring.js';

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
function setup(beforeCommit: () => Promise<void> = async () => {}, peerCount = 0) {
  const sessionId = randomUUID(),
    addressId = randomUUID(),
    instance = randomUUID(),
    now = new Date().toISOString(),
    key = 'owner-coordination-host',
    token = 'bridge-proof';
  const peerSeeds = Array.from({ length: peerCount }, (_, index) => ({
    id: randomUUID(),
    addressId: randomUUID(),
    instance: randomUUID(),
    token: `peer-proof-${index}`,
    name: `Peer ${index + 1}`,
  }));
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
      ...peerSeeds.map((peer) => ({
        id: peer.id,
        hostId: 1,
        agentBusAddressId: peer.addressId,
        engine: 'codex',
        username: 'root',
        cwd: '/repo',
        workspace: null,
        launchName: peer.name,
        bindingGeneration: 1,
        bridgeTokenHash: sha256(peer.token),
        hostAuthFingerprint: sha256(key),
        bridgeExpiresAt: '2099-01-01T00:00:00Z',
        endedAt: null,
        upstreamSessionId: null,
        adapterCapabilities: { scope_protocol_version: 1 },
      })),
    ],
    agentBusAddresses: [
      ...peerSeeds.map((peer) => ({
        id: peer.addressId,
        address: `agent:${peer.addressId}`,
        hostId: 1,
        engine: 'codex',
        currentSessionId: peer.id,
        bindingGeneration: 1,
        enabled: 1,
        archivedAt: null,
        launchName: peer.name,
      })),
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
  // MySQL assigns agent_bus_messages.dispatch_order by auto-increment; the fake
  // would echo the UUID primary key, so CLAIM/1 notices need a numeric one here.
  const insert = fake.insert.bind(fake) as (table: unknown) => { values: (values: unknown) => Promise<unknown> };
  let dispatchOrder = 0;
  fake.insert = ((table: unknown) =>
    table !== schema.agentBusMessages
      ? insert(table)
      : {
          values: (values: Record<string, unknown>) => {
            const done = insert(table).values(values).then(() => [
              { insertId: ++dispatchOrder, affectedRows: 1 },
            ]);
            return Object.assign(done, { onDuplicateKeyUpdate: () => done });
          },
        }) as typeof fake.insert;
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
  const peers = peerSeeds.map((peer) => {
    const attachPeer = () =>
      presence.attach({
        connectionId: randomUUID(),
        hostId: 1,
        username: 'root',
        scope: { topic: 'session', session_id: peer.id, binding_generation: 1, native_instance_id: peer.instance },
      });
    return { ...peer, attach: attachPeer, live: attachPeer() };
  });
  const service = new AgentCoordination(db, loadTestEnv(), testKeyring(), {} as AgentMessagingService);
  return { owner, state, select, fake, service, sessionId, token, instance, presence, attach, live, peers };
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

describe('waiting claim queue', () => {
  const heavy = [{ kind: 'service', service: 'heavy-build' }];
  const acquire = (h: ReturnType<typeof setup>, id: string, token: string, purpose = 'heavy build') =>
    h.service.claims.acquire(id, token, { client_request_id: randomUUID(), purpose, resources: heavy });
  const release = (h: ReturnType<typeof setup>, id: string | null, token: string | null, claimId: string, operator?: number) =>
    h.service.claims.release(id, token, { claim_id: claimId, outcome: 'completed', reason: 'build finished' }, operator);
  const stateOf = (h: ReturnType<typeof setup>, claimId: string) => h.state.snapshot().claims.get(claimId)?.state;
  const notices = (h: ReturnType<typeof setup>, sessionId: string) =>
    h.fake.inserts
      .filter((row) => row.table === schema.agentBusMessages)
      .map((row) => row.values as { targetSessionId: string; contentEnc: string })
      .filter((row) => row.targetSessionId === sessionId)
      .map((row) => decrypt(row.contentEnc, testKeyring()))
      .filter((content) => content.startsWith('CLAIM/1\n'));

  it('grants a waiter on release so the releasing owner cannot overtake it by re-acquiring', async () => {
    const h = setup(undefined, 1), [b] = h.peers;
    const first = await acquire(h, h.sessionId, h.token);
    const waiting = await acquire(h, b!.id, b!.token);
    expect(waiting.state).toBe('waiting');
    await release(h, h.sessionId, h.token, first.id);
    expect(stateOf(h, waiting.id)).toBe('active');
    const again = await acquire(h, h.sessionId, h.token);
    expect(again.state).toBe('waiting');
    expect(again.blockers).toEqual([expect.objectContaining({ id: waiting.id, session_id: b!.id, state: 'active' })]);
  });

  it('queues a re-acquisition behind an earlier waiter that is not yet granted', async () => {
    const h = setup(undefined, 1), [b] = h.peers;
    const first = await acquire(h, h.sessionId, h.token);
    const waiting = await acquire(h, b!.id, b!.token);
    // The release outcome is unknown, so the resource stays excluded and nobody is granted.
    await h.service.claims.release(h.sessionId, h.token, { claim_id: first.id, outcome: 'unknown', reason: 'lost track' });
    expect(stateOf(h, waiting.id)).toBe('waiting');
    const again = await acquire(h, h.sessionId, h.token);
    expect(again.state).toBe('waiting');
    expect(again.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: waiting.id, state: 'waiting' })]));
    await release(h, null, null, first.id, 7);
    expect(stateOf(h, waiting.id)).toBe('active');
    expect(stateOf(h, again.id)).toBe('waiting');
  });

  it('grants several waiters strictly in arrival order', async () => {
    const h = setup(undefined, 3), [b, c, d] = h.peers;
    const first = await acquire(h, h.sessionId, h.token);
    const second = await acquire(h, b!.id, b!.token);
    const third = await acquire(h, c!.id, c!.token);
    const fourth = await acquire(h, d!.id, d!.token);
    expect([second.state, third.state, fourth.state]).toEqual(['waiting', 'waiting', 'waiting']);
    expect((third.blockers as Array<{ id: string }>).map((row) => row.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    // A later waiter polling cannot jump ahead of an earlier one.
    expect((await h.service.claims.status(d!.id, d!.token, { claim_id: fourth.id })).state).toBe('waiting');
    await release(h, h.sessionId, h.token, first.id);
    expect([stateOf(h, second.id), stateOf(h, third.id), stateOf(h, fourth.id)]).toEqual(['active', 'waiting', 'waiting']);
    expect((await h.service.claims.status(d!.id, d!.token, { claim_id: fourth.id })).state).toBe('waiting');
    await release(h, b!.id, b!.token, second.id);
    expect([stateOf(h, third.id), stateOf(h, fourth.id)]).toEqual(['active', 'waiting']);
    await release(h, c!.id, c!.token, third.id);
    expect(stateOf(h, fourth.id)).toBe('active');
  });

  it('lets the holder re-enter its own resource before releasing it, keeping its slot ahead of waiters', async () => {
    // Deliberate trade-off: a nested (or shared parent/child) claim on resources the
    // session already holds must not deadlock behind waiters queued on that grant.
    // The consequence: acquiring the next claim before releasing the current one
    // keeps the slot; only release-then-acquire hands it to the queue.
    const h = setup(undefined, 1), [b] = h.peers;
    const outer = await acquire(h, h.sessionId, h.token);
    const waiting = await acquire(h, b!.id, b!.token);
    const nested = await acquire(h, h.sessionId, h.token, 'nested step');
    expect(nested.state).toBe('active');
    await release(h, h.sessionId, h.token, outer.id);
    expect(stateOf(h, waiting.id)).toBe('waiting');
    await release(h, h.sessionId, h.token, nested.id);
    expect(stateOf(h, waiting.id)).toBe('active');
  });

  it('skips a disconnected waiter without dropping its place for when it returns', async () => {
    const h = setup(undefined, 2), [b, c] = h.peers;
    const first = await acquire(h, h.sessionId, h.token);
    const early = await acquire(h, b!.id, b!.token);
    b!.live.detach();
    const late = await acquire(h, c!.id, c!.token);
    expect((late.blockers as Array<{ id: string }>).map((row) => row.id)).toEqual([first.id]);
    await release(h, h.sessionId, h.token, first.id);
    expect([stateOf(h, early.id), stateOf(h, late.id)]).toEqual(['waiting', 'active']);
    b!.attach();
    const polled = await h.service.claims.status(b!.id, b!.token, { claim_id: early.id });
    expect(polled.state).toBe('waiting');
    expect(polled.blockers).toEqual([expect.objectContaining({ id: late.id, state: 'active' })]);
  });

  it('promotes the queue head during reconciliation when an ended owner is released', async () => {
    const h = setup(undefined, 1), [b] = h.peers;
    const first = await acquire(h, h.sessionId, h.token);
    const waiting = await acquire(h, b!.id, b!.token);
    h.live.detach();
    await h.service.reconcileOwned();
    expect(stateOf(h, first.id)).toBe('uncertain');
    const draft = h.state.begin(), revision = h.state.revision();
    draft.upsert('agentSessions', { ...draft.table('agentSessions').get(h.sessionId)!, endedAt: new Date().toISOString() });
    h.state.publish(draft.seal({ ...revision, sequence: revision.sequence + 1n }));
    await h.service.reconcileOwned();
    expect([stateOf(h, first.id), stateOf(h, waiting.id)]).toEqual(['released', 'active']);
  });

  it('notifies the claimant once when its waiting claim becomes active, and the holder only about conflicts', async () => {
    const h = setup(undefined, 2), [b, c] = h.peers;
    const first = await acquire(h, h.sessionId, h.token);
    const waiting = await acquire(h, b!.id, b!.token);
    await acquire(h, c!.id, c!.token);
    // The holder hears about both requesters; an earlier waiter is not asked to coordinate.
    expect(notices(h, h.sessionId)).toHaveLength(2);
    expect(notices(h, b!.id)).toEqual([]);
    await release(h, h.sessionId, h.token, first.id);
    await h.service.reconcileOwned();
    await h.service.claims.status(b!.id, b!.token, { claim_id: waiting.id });
    const granted = notices(h, b!.id);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toContain(`Your waiting resource claim ${waiting.id} for heavy build is now active`);
    expect(notices(h, c!.id)).toEqual([]);
  });

  it('notifies a waiting claimant when an operator releases its claim', async () => {
    const h = setup(undefined, 1), [b] = h.peers;
    await acquire(h, h.sessionId, h.token);
    const waiting = await acquire(h, b!.id, b!.token);
    await h.service.claims.release(null, null, { claim_id: waiting.id, outcome: 'canceled', reason: 'slot reassigned' }, 7);
    expect(stateOf(h, waiting.id)).toBe('released');
    const refused = notices(h, b!.id);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain(`An operator released your waiting resource claim ${waiting.id}`);
    expect(refused[0]).toContain('Reason: slot reassigned');
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
