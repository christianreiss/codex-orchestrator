import { resumeNativeFixture } from './helpers/native-resume.js';
import { mutateOwnerState } from '../src/control-plane/state/runtime.js';
import { captureLegacyDrainManifest, LegacyDrainRegistry } from '../src/control-plane/legacy-drain.js';
import { withNativePrincipal } from '../src/control-plane/state/native-principal.js';
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
import { GitDirectorService } from '../src/services/git-director.js';
import { SettingsService } from '../src/services/settings.js';
import { AgentCoordination } from '../src/services/agent-coordination/index.js';
import type { AgentMessagingService } from '../src/services/agent-messaging.js';
import { sha256 } from '../src/security/hash.js';
import { createDbFake } from './helpers/db-fake.js';
import { loadTestEnv, testKeyring } from './helpers/test-keyring.js';

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
function setup(engine: 'codex' | 'claude' | 'grok' = 'codex') {
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
        engines: engine,
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
        engine,
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
        engine,
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
  const git = new GitDirectorService({ db, settings: new SettingsService(db) });
  return {
    owner,
    state,
    select,
    fake,
    service,
    sessionId,
    token,
    instance,
    presence,
    attach,
    live,
    git,
    host: state.snapshot().hosts.get(1)!,
  };
}
describe('connection-owned Git registrations', () => {
  it('requires the actual native owner to release a connection registration', async () => {
    const h = setup(), args = { worktree_path: '/repo', clone_dir: '/repo/.git', engine: 'codex', username: 'root', branch: 'work' };
    const registered = await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => h.git.register(args, h.host));
    await expect(h.git.release({ worktree_path: '/repo', deregister: true }, h.host)).rejects.toThrow('Authenticated original session');
    expect(h.state.snapshot().table('gitWorktrees').get(String(registered.worktree_id))?.status).toBe('active');
    const foreignId = randomUUID(), foreignAddress = randomUUID(), foreignToken = 'foreign-native';
    await mutateOwnerState(h.owner, { kind: 'test.foreign-native', payload: {}, prepare(ctx) {
      const session = ctx.snapshot.sessions.get(h.sessionId)!;
      ctx.draft.upsert('agentSessions', { ...session, id: foreignId, agentBusAddressId: foreignAddress, bridgeTokenHash: sha256(foreignToken) });
      const address = ctx.snapshot.addresses.get(session.agentBusAddressId!)!;
      ctx.draft.upsert('agentBusAddresses', { ...address, id: foreignAddress, address: 'agent:' + foreignAddress, currentSessionId: foreignId });
      return null;
    } });
    h.presence.attach({ connectionId: randomUUID(), hostId: 1, username: 'root', scope: { topic: 'session', session_id: foreignId, binding_generation: 1, native_instance_id: randomUUID() } });
    await expect(withNativePrincipal({ sessionId: foreignId, bridgeToken: foreignToken }, () => h.git.release({ worktree_path: '/repo', deregister: true }, h.host))).rejects.toThrow('another session binding');
    await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => h.git.release({ worktree_path: '/repo', deregister: true }, h.host));
  });

  it('registers once then reads occupancy without SQL or commands, preserving uncertain exclusion', async () => {
    const h = setup();
    const args = {
      worktree_path: '/repo',
      clone_dir: '/repo/.git',
      repo_root: '/repo',
      engine: 'codex',
      username: 'root',
      branch: 'work',
    };
    const registered = await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () =>
      h.git.register(args, h.host),
    );
    expect(registered.expires_at).toBeNull();
    const command = vi.spyOn(h.owner, 'execute');
    for (let n = 0; n < 10; n++) await h.git.list({ worktree_path: '/repo', scope: 'clone' }, h.host);
    expect(command).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
    h.live.detach();
    await h.git.reconcileOwned();
    const row = h.state.snapshot().table('gitWorktrees').all()[0]!;
    expect(row.status).toBe('uncertain');
    const wrong = h.attach(randomUUID());
    await expect(
      withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () =>
        h.git.register(args, h.host),
      ),
    ).rejects.toThrow('retains exclusion');
    wrong.detach();
    h.attach();
    await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () =>
      h.git.register(args, h.host),
    );
    expect(h.state.snapshot().table('gitWorktrees').get(row.id)?.status).toBe('active');
    await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => h.git.release({ worktree_path: '/repo', deregister: true }, h.host));
    expect(h.state.snapshot().table('gitWorktrees').get(row.id)?.status).toBe('released');
    expect(h.select).not.toHaveBeenCalled();
  });
  it('keeps merge permission absolute and never renews it through status polls', async () => {
    const h = setup();
    await h.service.claims.acquire(h.sessionId, h.token, {
      client_request_id: randomUUID(),
      purpose: 'merge fixture',
      resources: [
        { kind: 'path', host_id: 1, path: '/repo' },
        { kind: 'git', host_id: 1, common_dir: '/repo/.git', branch: 'main' },
      ],
    });
    await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () =>
      h.git.register(
        {
          worktree_path: '/repo',
          clone_dir: '/repo/.git',
          engine: 'codex',
          username: 'root',
          branch: 'work',
        },
        h.host,
      ),
    );
    const request = await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => h.git.requestMerge(
      {
        worktree_path: '/repo',
        target_branch: 'main',
        client_request_id: randomUUID(),
        changed_paths: ['src/main.ts'],
      },
      h.host,
    ));
    expect(request.verdict).toBe('allow');
    h.select.mockClear();
    const deadline = request.lease_expires_at,
      command = vi.spyOn(h.owner, 'execute');
    for (let n = 0; n < 10; n++)
      expect((await h.git.mergeStatus({ request_id: request.request_id }, h.host)).lease_expires_at).toBe(
        deadline,
      );
    expect(command).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
  });
});

describe('captured timed Git registration drain',()=>{
  async function legacy(captured=true){
    const h=setup(),args={worktree_path:'/repo',clone_dir:'/repo/.git',repo_root:'/repo',engine:'codex',username:'root',branch:'work'};
    const registered=await withNativePrincipal({sessionId:h.sessionId,bridgeToken:h.token},()=>h.git.register(args,h.host));
    const id=registered.worktree_id as string;
    const edit=(apply:(draft:ReturnType<typeof h.state.begin>)=>void)=>{const draft=h.state.begin();apply(draft);const revision=h.state.revision();h.state.publish(draft.seal({...revision,sequence:revision.sequence+1n}));};
    edit(draft=>{
      draft.upsert('gitWorktrees',{...draft.table('gitWorktrees').get(id)!,ownershipMode:'timed',nativeInstanceId:null,expiresAt:new Date(Date.now()+60000).toISOString()});
      draft.upsert('agentNativeControls',{sessionId:h.sessionId,instanceId:h.instance,bindingGeneration:1,status:'ready',updatedAt:new Date().toISOString(),requestId:null,clientMessageId:null,actorId:null});
    });
    const manifest=captureLegacyDrainManifest(h.state.snapshot(),Date.now(),{resourceClaimIds:[],gitRegistrationIds:captured?[id]:[]});
    edit(draft=>draft.upsert('gitWorktrees',{...draft.table('gitWorktrees').get(id)!,status:'uncertain',uncertaintyReason:'owner_restart'}));
    h.live.detach();const registry=new LegacyDrainRegistry(h.owner,manifest,{session:60000,relay:60000});closers.push(()=>registry.close());
    return {...h,args,id,edit,registry};
  }
  it('reports and releases the exact captured registration without promoting its ownership mode',async()=>{
    const h=await legacy(),before=h.state.snapshot().table('gitWorktrees').get(h.id)!;
    const report=await withNativePrincipal({sessionId:h.sessionId,bridgeToken:h.token},()=>h.git.register(h.args,h.host));
    expect(report.ownership_mode).toBe('timed');expect(report.presence_source).toBe('legacy_drain');
    expect(h.state.snapshot().table('gitWorktrees').get(h.id)?.expiresAt).toBe(before.expiresAt);
    const command=vi.spyOn(h.owner,'execute');
    for(let n=0;n<5;n++)await h.git.list({worktree_path:'/repo',scope:'clone'},h.host);
    expect(command).not.toHaveBeenCalled();expect(h.select).not.toHaveBeenCalled();
    await expect(withNativePrincipal({sessionId:h.sessionId,bridgeToken:h.token},()=>h.git.register({...h.args,worktree_path:'/new'},h.host))).rejects.toThrow();
    await withNativePrincipal({sessionId:h.sessionId,bridgeToken:h.token},()=>h.git.release({worktree_path:'/repo',deregister:true},h.host));
    expect(h.state.snapshot().table('gitWorktrees').get(h.id)?.status).toBe('released');
  });
  it('reports a captured registration after backup outlasts its old TTL only after exact native proof returns',async()=>{
    const h=await legacy(),before=h.state.snapshot().table('gitWorktrees').get(h.id)!;
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+120000);
    try {
      await expect(withNativePrincipal({sessionId:h.sessionId,bridgeToken:h.token},()=>h.git.register(h.args,h.host))).rejects.toThrow();
      h.registry.renew('session',h.sessionId,h.token,{instanceId:h.instance});
      const result=await withNativePrincipal({sessionId:h.sessionId,bridgeToken:h.token},()=>h.git.register(h.args,h.host));
      expect(result.ownership_mode).toBe('timed');expect(Date.parse(result.expires_at as string)).toBeGreaterThan(Date.now());
      expect(h.state.snapshot().table('gitWorktrees').get(h.id)?.expiresAt).toBe(before.expiresAt);
    } finally { clock.mockRestore(); }
  });
  it('rejects reporting after native freshness expires or host authority is revoked',async()=>{
    const h=await legacy();
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+46000);
    try { await expect(withNativePrincipal({sessionId:h.sessionId,bridgeToken:h.token},()=>h.git.register(h.args,h.host))).rejects.toThrow(); }
    finally { clock.mockRestore(); }
    const revoked=await legacy();revoked.edit(draft=>draft.upsert('hosts',{...draft.table('hosts').get(1)!,authFingerprint:'revoked'}));
    await expect(revoked.git.release({worktree_path:'/repo',deregister:true},revoked.host)).rejects.toThrow();
  });
  it('does not adopt uncaptured or changed-binding registrations',async()=>{
    const h=await legacy(false);
    await expect(withNativePrincipal({sessionId:h.sessionId,bridgeToken:h.token},()=>h.git.register(h.args,h.host))).rejects.toThrow();
    expect(h.state.snapshot().table('gitWorktrees').get(h.id)?.status).toBe('uncertain');
    const changed=await legacy();changed.edit(draft=>draft.upsert('agentSessions',{...draft.table('agentSessions').get(changed.sessionId)!,bindingGeneration:2}));
    await expect(changed.git.release({worktree_path:'/repo',deregister:true},changed.host)).rejects.toThrow();
    expect(changed.state.snapshot().table('gitWorktrees').get(changed.id)?.status).toBe('uncertain');
  });
});


describe('exact transcript Git continuation', () => {
  it.each(['same', 'foreign-transcript', 'old-attached'])('rebinds only a completed detached lifecycle and never carries merge permission (%s)', async (scenario) => {
    const h = setup();
    const claim = await h.service.claims.acquire(h.sessionId, h.token, { client_request_id: randomUUID(), purpose: 'merge continuation', resources: [{ kind: 'path', host_id: 1, path: '/repo' }, { kind: 'git', host_id: 1, common_dir: '/repo/.git', branch: 'main' }] });
    const args = { worktree_path: '/repo', clone_dir: '/repo/.git', engine: 'codex', username: 'root', branch: 'work' };
    const registered = await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => h.git.register(args, h.host));
    const lease = await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => h.git.requestMerge({ worktree_path: '/repo', target_branch: 'main', client_request_id: randomUUID(), changed_paths: ['src/main.ts'] }, h.host));
    expect(lease.verdict).toBe('allow');
    if (scenario !== 'old-attached') h.live.detach();
    const next = await resumeNativeFixture(h.owner, h.presence, h.sessionId);
    if (scenario === 'foreign-transcript') await mutateOwnerState(h.owner, { kind: 'test.foreign-transcript', payload: {}, prepare(ctx) { ctx.draft.upsert('agentSessions', { ...ctx.snapshot.sessions.get(next.id)!, upstreamSessionId: randomUUID() }); return null; } });
    await h.git.reconcileOwned();
    const register = () => withNativePrincipal({ sessionId: next.id, bridgeToken: next.token }, () => h.git.register(args, h.host));
    if (scenario === 'same') {
      await expect(withNativePrincipal({ sessionId: next.id, bridgeToken: next.token }, () => h.git.release({ worktree_path: '/repo', deregister: true }, h.host))).rejects.toMatchObject({
        code: 'git_director_owner_uncertain', message: expect.stringContaining('git_register'),
      });
      expect(await register()).toMatchObject({ registered: true, rebound: true, worktree_id: registered.worktree_id, withdrawn_request_ids: [lease.request_id] });
      expect(h.state.snapshot().table('gitMergeRequests').get(String(lease.request_id))?.verdict).toBe('withdrawn');
      expect(h.state.snapshot().table('gitWorktrees').get(String(registered.worktree_id))?.agentSessionId).toBe(next.id);
      await expect(withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => h.git.release({ worktree_path: '/repo', deregister: true }, h.host))).rejects.toThrow();
      await expect(withNativePrincipal({ sessionId: next.id, bridgeToken: next.token }, () => h.git.requestMerge({ worktree_path: '/repo', target_branch: 'main', client_request_id: randomUUID(), changed_paths: ['src/main.ts'] }, h.host))).rejects.toMatchObject({
        code: 'resource_claim_conflict', message: expect.stringContaining('resource_claim_status({claim_id,renew:true})'),
      });
      expect(await h.service.claims.status(next.id, next.token, { claim_id: claim.id, renew: true })).toMatchObject({ state: 'active', session_id: next.id });
      const fresh = await withNativePrincipal({ sessionId: next.id, bridgeToken: next.token }, () => h.git.requestMerge({ worktree_path: '/repo', target_branch: 'main', client_request_id: randomUUID(), changed_paths: ['src/main.ts'] }, h.host));
      expect(fresh.verdict).toBe('allow');
      expect(fresh.request_id).not.toBe(lease.request_id);
      await withNativePrincipal({ sessionId: next.id, bridgeToken: next.token }, () => h.git.release({ worktree_path: '/repo', deregister: true }, h.host));
    } else if (scenario === 'foreign-transcript') {
      // The original lifecycle ended and nobody can continue its transcript:
      // its registration is abandoned and its lease reclaimed, so the path is
      // free for any session rather than wedged until an operator evicts it.
      expect(h.state.snapshot().table('gitWorktrees').get(String(registered.worktree_id))?.status).toBe('abandoned');
      expect(h.state.snapshot().table('gitMergeRequests').get(String(lease.request_id))?.verdict).toBe('expired');
      expect(await register()).toMatchObject({ registered: true });
      expect(h.state.snapshot().table('gitWorktrees').get(String(registered.worktree_id))?.agentSessionId).toBe(next.id);
    } else {
      await expect(register()).rejects.toThrow('retains exclusion');
      expect(h.state.snapshot().table('gitWorktrees').get(String(registered.worktree_id))?.agentSessionId).toBe(h.sessionId);
    }
  });
});

it.each(['codex','claude','grok'] as const)('%s explains missing native Git proof without creating registrations',async engine=>{
 const h=setup(engine),args={worktree_path:'/repo',clone_dir:'/repo/.git',repo_root:'/repo',engine,username:'root',branch:'work'};
 await expect(h.git.register(args,h.host)).rejects.toMatchObject({code:'git_director_owner_required',message:expect.stringContaining('cxx communicator status')});
 await expect(withNativePrincipal({sessionId:h.sessionId,bridgeToken:h.token},()=>h.git.register({...args,worktree_path:'/nested'},h.host))).rejects.toMatchObject({code:'git_director_owner_required',message:expect.stringContaining('agent_context_update')});
 h.live.detach();
 await expect(withNativePrincipal({sessionId:h.sessionId,bridgeToken:h.token},()=>h.git.register(args,h.host))).rejects.toMatchObject({code:'git_director_owner_required',message:expect.stringContaining('cxx communicator status')});
 expect(h.state.snapshot().table('gitWorktrees').all()).toHaveLength(0);
});

describe('Git Director feedback sweep (registration state, remotes, nesting, list filters)', () => {
  const as = <T>(h: ReturnType<typeof setup>, run: () => Promise<T>) =>
    withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, run);
  const edit = (h: ReturnType<typeof setup>, apply: (draft: ReturnType<typeof h.state.begin>) => void) => {
    const draft = h.state.begin();
    apply(draft);
    const revision = h.state.revision();
    h.state.publish(draft.seal({ ...revision, sequence: revision.sequence + 1n }));
  };
  const claimRepo = (h: ReturnType<typeof setup>, root = '/repo', commonDir = '/repo/.git') =>
    h.service.claims.acquire(h.sessionId, h.token, {
      client_request_id: randomUUID(),
      purpose: 'feedback sweep',
      resources: [
        { kind: 'path', host_id: 1, path: root },
        { kind: 'git', host_id: 1, common_dir: commonDir, branch: 'main' },
      ],
    });
  const base = { worktree_path: '/repo', clone_dir: '/repo/.git', repo_root: '/repo', engine: 'codex', username: 'root', branch: 'work' };
  const withWorkspace = (h: ReturnType<typeof setup>) =>
    mutateOwnerState(h.owner, { kind: 'test.workspace', payload: {}, prepare(ctx) {
      ctx.draft.upsert('agentSessions', { ...ctx.snapshot.sessions.get(h.sessionId)!, workspace: {
        cwd: '/repo', git_status: 'repository', git_root: '/repo', git_common_dir: '/repo/.git', branch: 'work', head_sha: null, repository_key: null,
      } });
      return null;
    } });

  it('names an uncertain registration on merge, and git_join restores it completely (a4ce60ec, 2b7d13fe)', async () => {
    const h = setup();
    await claimRepo(h);
    const registered = await as(h, () => h.git.register(base, h.host));
    const id = String(registered.worktree_id);
    edit(h, (draft) => draft.upsert('gitWorktrees', { ...draft.table('gitWorktrees').get(id)!, status: 'uncertain', uncertaintyReason: 'owner_restart' }));
    const ask = () => as(h, () => h.git.requestMerge({ worktree_path: '/repo', target_branch: 'main', client_request_id: 'same-id', changed_paths: ['src/a.ts'] }, h.host));
    await expect(ask()).rejects.toMatchObject({
      code: 'git_director_owner_uncertain',
      message: expect.stringMatching(/uncertain \(owner_restart\)[\s\S]*git_register/),
    });
    const joined = await as(h, () => h.git.join({ worktree_path: '/repo', target_branch: 'main' }, h.host));
    expect(joined.restored_registration).toEqual({ status: 'uncertain', uncertainty_reason: 'owner_restart' });
    const row = h.state.snapshot().table('gitWorktrees').get(id)!;
    expect(row.status).toBe('active');
    expect(row.uncertaintyReason).toBeNull();
    expect((await ask()).verdict).toBe('allow');
    const again = await as(h, () => h.git.join({ worktree_path: '/repo' }, h.host));
    expect(again.restored_registration).toBeUndefined();
  });

  it('git_director_worktree_changed names the recorded field that changed while judging (5d35864a)', async () => {
    const h = setup();
    await claimRepo(h);
    let id = '';
    const judge = { model: 'fixture', judge: async () => {
      edit(h, (draft) => draft.upsert('gitWorktrees', { ...draft.table('gitWorktrees').get(id)!, status: 'uncertain', uncertaintyReason: 'disconnected' }));
      return { verdict: 'wait' as const, reason: 'fixture' };
    } };
    const deps = (h.git as unknown as { deps: { db: Database; settings: SettingsService } }).deps;
    const git = new GitDirectorService({ db: deps.db, settings: deps.settings, judge });
    id = String((await as(h, () => git.register(base, h.host))).worktree_id);
    const first = await as(h, () => git.requestMerge({ worktree_path: '/repo', target_branch: 'main', client_request_id: randomUUID(), changed_paths: ['src/a.ts'] }, h.host));
    expect(first.verdict).toBe('allow');
    await expect(as(h, () => git.requestMerge({ worktree_path: '/repo', target_branch: 'main', client_request_id: randomUUID(), changed_paths: ['src/a.ts'] }, h.host))).rejects.toMatchObject({
      code: 'git_director_worktree_changed',
      message: expect.stringContaining('status uncertain (disconnected)'),
      extra: expect.objectContaining({ changed: expect.arrayContaining(['status']) }),
    });
  });

  it('refuses to replace a live clone remote with a different repository (00c4d271)', async () => {
    const h = setup();
    const real = 'ssh://git@git.alpha-labs.net:2222/eulotorium/nekoma2.git';
    await as(h, () => h.git.register({ ...base, remote_url: real }, h.host));
    const clone = () => h.state.snapshot().table('gitClones').all()[0]!;
    const key = clone().remoteKey;
    await expect(as(h, () => h.git.register({ ...base, remote_url: 'ssh://git@git@git.alpha-labs.net:2222/eulotorium/nekoma2.git' }, h.host))).rejects.toMatchObject({
      code: 'git_director_remote_mismatch',
      message: expect.stringContaining(real),
    });
    expect(clone().remoteKey).toBe(key);
    expect(clone().remoteUrl).toBe(real);
    // Another spelling of the same repository is not a change.
    await as(h, () => h.git.register({ ...base, remote_url: 'https://git.alpha-labs.net/eulotorium/nekoma2' }, h.host));
    expect(clone().remoteKey).toBe(key);
    // With no live registration left, a genuine move is accepted.
    await as(h, () => h.git.release({ worktree_path: '/repo', deregister: true }, h.host));
    await as(h, () => h.git.register({ ...base, remote_url: 'https://example.test/moved/repo.git' }, h.host));
    expect(clone().remoteKey).not.toBe(key);
  });

  it('registers a nested repository below the bound checkout without rebinding (054da397)', async () => {
    const h = setup();
    await withWorkspace(h);
    await as(h, () => h.git.register(base, h.host));
    const nested = await as(h, () => h.git.register({ ...base, worktree_path: '/repo/MD', clone_dir: '/repo/MD/.git', repo_root: '/repo/MD', branch: 'master' }, h.host));
    expect(nested).toMatchObject({ registered: true, agent_address_bound: true });
    // Same repository below the root, or a sibling path, still needs agent_context_update.
    for (const args of [
      { ...base, worktree_path: '/repo/sub', clone_dir: '/repo/.git' },
      { worktree_path: '/repo/sub', repo_root: '/repo/sub', engine: 'codex', username: 'root' },
      { ...base, worktree_path: '/repository/MD', clone_dir: '/repository/MD/.git' },
    ])
      await expect(as(h, () => h.git.register(args, h.host))).rejects.toMatchObject({ code: 'git_director_owner_required' });
    await claimRepo(h, '/repo/MD', '/repo/MD/.git');
    expect((await as(h, () => h.git.requestMerge({ worktree_path: '/repo/MD', target_branch: 'main', client_request_id: randomUUID(), changed_paths: ['x.md'] }, h.host))).verdict).toBe('allow');
    expect(h.state.snapshot().table('gitWorktrees').all().filter((row) => row.status === 'active')).toHaveLength(2);
  });

  it('filters git_list by remote_url and clone_dir (ee7397de)', async () => {
    const h = setup();
    await withWorkspace(h);
    await as(h, () => h.git.register({ ...base, remote_url: 'git@example.test:org/parent.git' }, h.host));
    await as(h, () => h.git.register({ ...base, worktree_path: '/repo/MD', clone_dir: '/repo/MD/.git', repo_root: '/repo/MD', remote_url: 'https://example.test/org/md' }, h.host));
    expect((await h.git.list({}, h.host)).total).toBe(2);
    const byRemote = await h.git.list({ remote_url: 'https://example.test/org/parent' }, h.host);
    expect(byRemote).toMatchObject({ total: 1, clones: [expect.objectContaining({ clone_dir: '/repo/.git' })] });
    const byDir = await h.git.list({ clone_dir: '/repo/MD/.git/' }, h.host);
    expect(byDir).toMatchObject({ total: 1, clones: [expect.objectContaining({ clone_dir: '/repo/MD/.git' })] });
    expect((await h.git.list({ remote_url: 'https://example.test/org/none' }, h.host)).total).toBe(0);
  });
});

describe('offline Git registration owners', () => {
  const GRACE = 5 * 60_000;
  const foreign = async (h: ReturnType<typeof setup>) => {
    const id = randomUUID(), address = randomUUID(), token = 'foreign-native';
    await mutateOwnerState(h.owner, { kind: 'test.foreign-native', payload: {}, prepare(ctx) {
      const session = ctx.snapshot.sessions.get(h.sessionId)!;
      ctx.draft.upsert('agentSessions', { ...session, id, agentBusAddressId: address, upstreamSessionId: randomUUID(), bridgeTokenHash: sha256(token) });
      const row = ctx.snapshot.addresses.get(session.agentBusAddressId!)!;
      ctx.draft.upsert('agentBusAddresses', { ...row, id: address, address: 'agent:' + address, currentSessionId: id });
      return null;
    } });
    h.presence.attach({ connectionId: randomUUID(), hostId: 1, username: 'root', scope: { topic: 'session', session_id: id, binding_generation: 1, native_instance_id: randomUUID() } });
    return { id, token };
  };
  it('abandons the registration of an owner offline past the grace, reclaims its lease and frees the path', async () => {
    const h = setup(), args = { worktree_path: '/repo', clone_dir: '/repo/.git', engine: 'codex', username: 'root', branch: 'work' };
    await h.service.claims.acquire(h.sessionId, h.token, { client_request_id: randomUUID(), purpose: 'merge fixture', resources: [{ kind: 'path', host_id: 1, path: '/repo' }, { kind: 'git', host_id: 1, common_dir: '/repo/.git', branch: 'main' }] });
    const registered = await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => h.git.register(args, h.host));
    const lease = await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => h.git.requestMerge({ worktree_path: '/repo', target_branch: 'main', client_request_id: randomUUID(), changed_paths: ['src/main.ts'] }, h.host));
    expect(lease.verdict).toBe('allow');
    h.live.detach();
    await h.git.reconcileOwned();
    const row = () => h.state.snapshot().table('gitWorktrees').get(String(registered.worktree_id))!;
    expect(row()).toMatchObject({ status: 'uncertain', uncertaintyReason: 'disconnected' });
    const other = await foreign(h);
    await expect(withNativePrincipal({ sessionId: other.id, bridgeToken: other.token }, () => h.git.register(args, h.host))).rejects.toThrow('retains exclusion');
    const later = new GitDirectorService({ db: h.fake as unknown as Database, settings: new SettingsService(h.fake as unknown as Database), now: () => new Date(Date.now() + GRACE + 30_000).toISOString() });
    await later.reconcileOwned();
    expect(row()).toMatchObject({ status: 'abandoned' });
    expect(row().releasedAt).not.toBeNull();
    expect(h.state.snapshot().table('gitMergeRequests').get(String(lease.request_id))).toMatchObject({ verdict: 'expired' });
    expect(h.state.snapshot().sessions.get(h.sessionId)?.endedAt).toBeNull();
    expect(await withNativePrincipal({ sessionId: other.id, bridgeToken: other.token }, () => h.git.register(args, h.host))).toMatchObject({ registered: true });
    expect(row()).toMatchObject({ status: 'active', agentSessionId: other.id });
  });
  it('keeps the registration of an owner that reconnected', async () => {
    const h = setup(), args = { worktree_path: '/repo', clone_dir: '/repo/.git', engine: 'codex', username: 'root', branch: 'work' };
    const registered = await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => h.git.register(args, h.host));
    h.live.detach();
    await h.git.reconcileOwned();
    h.attach();
    const later = new GitDirectorService({ db: h.fake as unknown as Database, settings: new SettingsService(h.fake as unknown as Database), now: () => new Date(Date.now() + 10 * GRACE).toISOString() });
    await later.reconcileOwned();
    expect(h.state.snapshot().table('gitWorktrees').get(String(registered.worktree_id))?.status).toBe('uncertain');
  });
});
