import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerStateSnapshot, OwnerStateStore, EntityView } from '../../../src/control-plane/state/store.js';
import type { StateSeed, StateRow } from '../../../src/control-plane/state/catalog.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { bindOwnerRetention } from '../../../src/services/server-retention/owner.js';
import { RetentionDeadlineIndex, RETENTION_FAMILIES } from '../../../src/services/server-retention/deadlines.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { portalObligations, PORTAL_MAINTENANCE_TABLES } from '../../../src/ops/portal-obligations.js';
import { createOwnerWorker } from '../../../src/ops/owner-worker.js';

afterEach(()=>vi.useRealTimers());
describe('retention lifecycle invalidation',()=>{
  it('parks protected history through contact updates, wakes at age deadline and on lifecycle release',async()=>{
    vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-24T00:00:00Z'));
    const now=Date.now(), id=randomUUID(), claim=randomUUID();
    const state=new OwnerStateStore(new OwnerStateSnapshot({epoch:randomUUID(),sequence:0n},{
      agentSessions:[{id,agentBusAddressId:null,status:'active',endedAt:null,activeTurnId:null,bindingGeneration:1,heartbeatAt:new Date(now).toISOString(),expiresAt:new Date(now-1000).toISOString()}, {id:randomUUID(),agentBusAddressId:null,status:'ended',endedAt:new Date(now-2000).toISOString(),expiresAt:new Date(now-1000).toISOString(),bindingGeneration:1}],
      agentResourceClaims:[{id:claim,sessionId:id,state:'active'}],
    } as unknown as StateSeed));
    const index=new RetentionDeadlineIndex();
    const read=vi.fn(async()=>({past:true,next:null})); await index.hydrate(read);
    for(const family of RETENTION_FAMILIES) index.publishSweep(family,{past:true,next:null},0);
    const errors=vi.fn(), deadlines=new DeadlineQueue(errors);
    const runtime={state,deadlines,assertOwner:vi.fn()} as unknown as OwnerRuntime;
    bindOwnerRetention(runtime,index);
    const run=vi.fn(async()=>({observed:true as const}));
    const facts={revision:()=>String(state.revision().sequence),relayConnected:()=>false,sessionConnected:()=>false,receiverConnected:()=>false,conferenceHasPendingDeliveries:()=>false};
    const worker=createOwnerWorker(runtime,{name:'history-proof',tables:PORTAL_MAINTENANCE_TABLES,select:snapshot=>[...portalObligations(snapshot,facts,0),...index.obligations()],subscribe:cb=>index.subscribe(cb),run,error:errors});
    const all=vi.spyOn(EntityView.prototype,'all');
    function update(patch:Partial<StateRow<'agentSessions'>>) {
      const draft=state.begin();draft.upsert('agentSessions',{...state.snapshot().sessions.get(id)!,...patch});
      state.publish(draft.seal({...state.revision(),sequence:state.revision().sequence+1n}));
    }
    for(let i=1;i<=20;i++){
      await vi.advanceTimersByTimeAsync(1000);
      update({heartbeatAt:new Date().toISOString(),updatedAt:new Date().toISOString(),receiver:{heartbeat_at:new Date().toISOString()}});
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(run).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(RETENTION_FAMILIES.length);
    expect(index.obligations().every(work=>work.dueAt>Date.now())).toBe(true);
    expect(all.mock.contexts.every(view=>view instanceof EntityView && view.name!=='agentBusMessages')).toBe(true);
    all.mockRestore();
    // The earliest actual future guard remains scheduled despite later contact.
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    for(const family of RETENTION_FAMILIES) index.publishSweep(family,{past:true,next:null},0);
    update({endedAt:new Date().toISOString(),status:'ended'});
    expect(index.obligations().some(work=>work.dueAt===0)).toBe(true);
    for(const family of RETENTION_FAMILIES) index.publishSweep(family,{past:true,next:null},0);
    const draft=state.begin();draft.upsert('agentResourceClaims',{...state.snapshot().table('agentResourceClaims').get(claim)!,state:'released'});
    state.publish(draft.seal({...state.revision(),sequence:state.revision().sequence+1n}));
    expect(index.obligations().some(work=>work.dueAt===0)).toBe(true);
    for(const family of RETENTION_FAMILIES) index.publishSweep(family,{past:true,next:null},0);
    const futureExpiry=Date.now()+60000;
    update({expiresAt:new Date(futureExpiry).toISOString()});
    expect(index.obligations().find(work=>work.key==='history:portal')?.dueAt).toBe(futureExpiry);
    expect(portalObligations(state.snapshot(),facts,0).some(work=>work.key.startsWith('session:'))).toBe(false);
    await worker.close();
  });
  it('does not wake for repeated equal or later staged deadlines',async()=>{
    const index=new RetentionDeadlineIndex();await index.hydrate(async()=>({past:false,next:null}),1000);
    const wake=vi.fn();index.subscribe(wake);
    index.stage('rooms',5000,1000);const initial=index.obligations();
    index.stage('rooms',5000,1000);index.stage('rooms',6000,1000);
    expect(index.obligations()).toEqual(initial);expect(wake).toHaveBeenCalledTimes(1);
    index.stage('rooms',900,1000);expect(index.obligations()[0]?.dueAt).toBe(0);
    const dirty=index.obligations();index.stage('rooms',900,1000);
    expect(index.obligations()).toEqual(dirty);expect(wake).toHaveBeenCalledTimes(2);
  });
});
