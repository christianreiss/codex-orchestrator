import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { purgeCold, coldPreview, coldClock } from '../../../src/services/server-retention/cold.js';
import { DEFAULT_SERVER_RETENTION } from '../../../src/services/server-retention/policy.js';
import { retentionStatus, saveRetentionPolicy, requestRetentionRun, MANUAL_RETENTION_FAMILIES } from '../../../src/services/server-retention/admin.js';
import { runOwnerPortalRetention } from '../../../src/services/server-retention/portal-owner.js';
import { runOwnerHistoryRetention } from '../../../src/services/server-retention/owner.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const config = readDbConfig();
describe.skipIf(!config)('retention policy on MySQL', () => {
  it('deletes optional quota history while preserving latest provider readings and usable baselines', async () => {
    const pool=mysql.createPool({...config!,connectionLimit:4}),db=drizzle(pool,{schema,mode:'default'}),keyring=testKeyring();
    const old=new Date(946684800000+Math.floor(Math.random()*86400000)).toISOString(),later='2001-01-01T00:00:00.000Z',now=new Date().toISOString();
    const accounts:number[]=[],graphs:number[]=[],claudeGraphs:number[]=[];
    let plane:Awaited<ReturnType<typeof createOwnedControlPlane>>|undefined;
    try {
      for(const engine of ['codex','claude']){const [row]=await db.insert(schema.providerAccounts).values({engine,label:randomUUID(),createdAt:now,updatedAt:now}).$returningId();accounts.push(row!.id);}
      await db.insert(schema.chatgptUsageSnapshots).values([{accountId:accounts[0],status:'ok',fetchedAt:old,nextEligibleAt:old,createdAt:old},{accountId:accounts[0],status:'ok',fetchedAt:later,nextEligibleAt:later,createdAt:later},{accountId:accounts[0],status:'error',fetchedAt:now,nextEligibleAt:now,createdAt:now}]);
      await db.insert(schema.claudeUsageSnapshots).values([{accountId:accounts[1],fetchedAt:old,createdAt:old},{accountId:accounts[1],fetchedAt:now,createdAt:now}]);
      for(const fetchedAt of [old,now]) {
        const [a]=await db.insert(schema.dashboardGraphQuotaSnapshots).values({fetchedAt,createdAt:fetchedAt}).$returningId();graphs.push(a!.id);
        const [b]=await db.insert(schema.dashboardGraphClaudeQuotaSnapshots).values({snapshotAt:fetchedAt,createdAt:fetchedAt}).$returningId();claudeGraphs.push(b!.id);
      }
      plane=await createOwnedControlPlane({pool,handle:db,env:{...loadTestEnv(),DB_DATABASE:String(config!.database)},keyring,error(error){throw error;}});
      for(let i=0;i<5;i++) await mutateOwnerState(plane.runtime,{kind:'test.quota.retention',payload:{},prepare(ctx){ctx.write(async tx=>{await purgeCold(ctx,tx,'quota',{...DEFAULT_SERVER_RETENTION,armed:true});});return null;}});
      expect((await db.select().from(schema.chatgptUsageSnapshots).where(eq(schema.chatgptUsageSnapshots.accountId,accounts[0]!))).map(r=>r.fetchedAt).sort()).toEqual([later,now].sort());
      expect((await db.select().from(schema.claudeUsageSnapshots).where(eq(schema.claudeUsageSnapshots.accountId,accounts[1]!))).map(r=>r.fetchedAt)).toEqual([now]);
      expect(await db.select().from(schema.dashboardGraphQuotaSnapshots).where(eq(schema.dashboardGraphQuotaSnapshots.id,graphs[0]!))).toHaveLength(0);
      expect(await db.select().from(schema.dashboardGraphQuotaSnapshots).where(eq(schema.dashboardGraphQuotaSnapshots.id,graphs[1]!))).toHaveLength(1);
      expect(await db.select().from(schema.dashboardGraphClaudeQuotaSnapshots).where(eq(schema.dashboardGraphClaudeQuotaSnapshots.id,claudeGraphs[0]!))).toHaveLength(0);
      expect(await db.select().from(schema.dashboardGraphClaudeQuotaSnapshots).where(eq(schema.dashboardGraphClaudeQuotaSnapshots.id,claudeGraphs[1]!))).toHaveLength(1);
    } finally {
      await plane?.close();
      for(const id of accounts) {await db.delete(schema.chatgptUsageSnapshots).where(eq(schema.chatgptUsageSnapshots.accountId,id));await db.delete(schema.claudeUsageSnapshots).where(eq(schema.claudeUsageSnapshots.accountId,id));await db.delete(schema.providerAccounts).where(eq(schema.providerAccounts.id,id));}
      for(const id of graphs) await db.delete(schema.dashboardGraphQuotaSnapshots).where(eq(schema.dashboardGraphQuotaSnapshots.id,id));
      for(const id of claudeGraphs) await db.delete(schema.dashboardGraphClaudeQuotaSnapshots).where(eq(schema.dashboardGraphClaudeQuotaSnapshots.id,id));
      await pool.end();
    }
  });
  it('resumes a recorded run after restart and refuses to replay an overwritten status slot', async () => {
    const pool=mysql.createPool({...config!,connectionLimit:4}),keyring=testKeyring();
    let db=drizzle(pool,{schema,mode:'default'});
    const env={...loadTestEnv(),DB_DATABASE:String(config!.database)};
    const saved=await db.select().from(schema.versions).where(eq(schema.versions.name,'server_retention_run_v1'));
    let plane:Awaited<ReturnType<typeof createOwnedControlPlane>>|undefined;
    let previous:ReturnType<typeof retentionStatus>['policy']|undefined;
    try {
      plane=await createOwnedControlPlane({pool,handle:db,env,keyring,error(error){throw error;}});
      const before=retentionStatus(db);previous=before.policy;
      await saveRetentionPolicy(db,{policy:{...previous,armed:true},expected_revision:before.revision});
      // A fresh test run replaces any previous lab-maintenance status.
      await mutateOwnerState(plane.runtime,{kind:'test.retention.reset',payload:{},prepare(ctx){const row={name:'server_retention_run_v1',version:'{}',updatedAt:new Date().toISOString()};ctx.draft.upsert('versions',row);ctx.write(tx=>tx.insert(schema.versions).values(row).onDuplicateKeyUpdate({set:{version:row.version}}));return null;}});
      const id=randomUUID(),revision=retentionStatus(db).revision;
      expect(await requestRetentionRun(db,{client_request_id:id,expected_revision:revision})).toMatchObject({id,status:'running'});
      await plane.close();plane=undefined;
      db=drizzle(pool,{schema,mode:'default'});
      plane=await createOwnedControlPlane({pool,handle:db,env,keyring,error(error){throw error;}});
      expect(MANUAL_RETENTION_FAMILIES.every(f=>plane!.retention.obligations().some(o=>o.key===`history:${f}`&&o.dueAt===0))).toBe(true);
      for(const family of MANUAL_RETENTION_FAMILIES) await runOwnerPortalRetention(db,plane.runtime,env,{key:`history:${family}`,dueAt:0,revision:'test'});
      for(let i=0;i<30&&retentionStatus(db).run?.status==='running';i++) {
        const next=plane.retention.obligations().filter(o=>MANUAL_RETENTION_FAMILIES.some(f=>o.key===`history:${f}`)).sort((a,b)=>a.dueAt-b.dueAt)[0];
        if(!next||next.dueAt>Date.now()+2000) break;
        await new Promise(resolve=>setTimeout(resolve,Math.max(0,next.dueAt-Date.now())));
        await runOwnerPortalRetention(db,plane.runtime,env,next);
      }
      expect(retentionStatus(db).run).toMatchObject({id,status:'completed'});
      const nextId=randomUUID();
      await requestRetentionRun(db,{client_request_id:nextId,expected_revision:revision});
      await expect(requestRetentionRun(db,{client_request_id:id,expected_revision:revision})).rejects.toMatchObject({code:'retention_run_not_found'});
      expect(retentionStatus(db).run?.id).toBe(nextId);
      await saveRetentionPolicy(db,{policy:previous,expected_revision:retentionStatus(db).revision});
    } finally {
      await plane?.close();
      await db.delete(schema.versions).where(eq(schema.versions.name,'server_retention_run_v1'));
      if(saved.length) await db.insert(schema.versions).values(saved);
      await pool.end();
    }
  });
  it('keeps connection-owned grants, queued work and uncertain daemons despite old history', async () => {
    const pool=mysql.createPool({...config!,connectionLimit:4}),db=drizzle(pool,{schema,mode:'default'}),keyring=testKeyring();
    const ids=[randomUUID(),randomUUID()],old='2000-01-01T00:00:00.000Z',run=randomUUID(),daemon=randomUUID();
    let plane:Awaited<ReturnType<typeof createOwnedControlPlane>>|undefined;
    let userId=0,hostId=0;
    try {
      const [host]=await db.insert(schema.hosts).values({fqdn:randomUUID()+'.test',apiKey:randomUUID(),secure:1,status:'active',engines:'codex,claude,grok',createdAt:old,updatedAt:old}).$returningId();
      hostId=host!.id;
      const [user]=await db.insert(schema.adminUsers).values({name:'retention fixture',username:randomUUID(),email:randomUUID()+'@test.invalid',passwordHash:'unused',accessLevel:'owner',createdAt:old,updatedAt:old}).$returningId();
      userId=user!.id;
      await db.insert(schema.providerAccountSessions).values(ids.map((id,i)=>({id,hostId:999999,engine:'grok',scopeId:randomUUID(),accountId:999999,ownershipMode:i===0?'connection' as const:'timed' as const,expiresAt:old,createdAt:old})));
      await db.insert(schema.chattySessions).values({userId,generation:1,selection:{engine:'grok',model:null},updatedAt:old});
      await db.insert(schema.chattyRuns).values({id:run,userId,adminSessionId:999999,generation:1,clientMessageId:randomUUID(),requestHash:'0'.repeat(64),status:'queued',inputEnc:'unused',stateEnc:'unused',createdAt:old,updatedAt:old});
      await db.insert(schema.hostDaemonSessions).values({id:daemon,hostId,owner:'test',engine:'grok',username:'test',cwd:'/fixture',title:'unknown',status:'unknown',lastActivityAt:old,createdAt:old});
      const env={...loadTestEnv(),DB_DATABASE:String(config!.database)};
      plane=await createOwnedControlPlane({pool,handle:db,env,keyring,error(error){throw error;}});
      await runOwnerHistoryRetention(db,plane.runtime,'credentials',env);
      await runOwnerHistoryRetention(db,plane.runtime,'chatty',env);
      await runOwnerHistoryRetention(db,plane.runtime,'daemons',env);
      expect(await db.select().from(schema.providerAccountSessions).where(eq(schema.providerAccountSessions.id,ids[0]!))).toHaveLength(1);
      expect(await db.select().from(schema.providerAccountSessions).where(eq(schema.providerAccountSessions.id,ids[1]!))).toHaveLength(0);
      expect((await db.select().from(schema.chattyRuns).where(eq(schema.chattyRuns.id,run)))[0]?.status).toBe('queued');
      expect((await db.select().from(schema.hostDaemonSessions).where(eq(schema.hostDaemonSessions.id,daemon)))[0]?.status).toBe('unknown');
    } finally {
      await plane?.close();
      for(const id of ids) await db.delete(schema.providerAccountSessions).where(eq(schema.providerAccountSessions.id,id));
      await db.delete(schema.chattyRuns).where(eq(schema.chattyRuns.id,run));
      await db.delete(schema.chattySessions).where(eq(schema.chattySessions.userId,userId));
      await db.delete(schema.adminUsers).where(eq(schema.adminUsers.id,userId));
      await db.delete(schema.hostDaemonSessions).where(eq(schema.hostDaemonSessions.id,daemon));
      await db.delete(schema.hosts).where(eq(schema.hosts.id,hostId));
      await pool.end();
    }
  });
  it('deletes aged audit, compacts external results, keeps open effects and parks protected receipts', async () => {
    const pool = mysql.createPool({ ...config!, connectionLimit:4 }), db = drizzle(pool,{schema,mode:'default'});
    const principal = 'test:'+randomUUID(), keyring=testKeyring(), old='2000-01-01T00:00:00.000Z', now=new Date().toISOString();
    const ids = [randomUUID(),randomUUID(),randomUUID()], effect=randomUUID(), action='test.retention.'+randomUUID();
    const policy = { ...DEFAULT_SERVER_RETENTION, armed:true };
    let plane: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
    try {
      await db.insert(schema.logs).values([{action,createdAt:old},{action,createdAt:now},{action,createdAt:'not-a-date'}]);
      await db.insert(schema.controlPlaneCommandReceipts).values(ids.map((id,i)=>({principal,requestId:id,kind:'fixture',requestDigest:'a'.repeat(64),ownerEpoch:randomUUID(),sequence:0n,resultEnc:encrypt(JSON.stringify({value:i}),keyring),createdAt:old,replayClass:i===1?'internal':'legacy',resultState:'available'})));
      await db.insert(schema.controlPlaneOutbox).values({id:effect,principal,requestId:ids[2]!,kind:'fixture',target:'fixture',payloadEnc:encrypt('{}',keyring),availableAt:'2099-01-01T00:00:00Z',createdAt:now});
      plane = await createOwnedControlPlane({pool,handle:db,env:{...loadTestEnv(),DB_DATABASE:String(config!.database)},keyring,error(error){throw error;}});
      const sweep=async(family:'auditlogs'|'receipts')=>{
        let n=0;
        await mutateOwnerState(plane!.runtime,{kind:'test.retention',payload:{family},prepare(context){context.write(async tx=>{n=await purgeCold(context,tx,family,policy);});return()=>n;}});
        return n;
      };
      // Preview is read-only and uses exactly the same cold eligibility guards.
      expect((await coldPreview(db,policy)).receipts!.eligible).toBeGreaterThanOrEqual(2);
      await sweep('auditlogs');
      expect((await db.select().from(schema.logs).where(eq(schema.logs.action,action))).map(row=>row.createdAt).sort()).toEqual([now,'not-a-date'].sort());
      await sweep('receipts'); await sweep('receipts');
      const retained=await db.select().from(schema.controlPlaneCommandReceipts).where(eq(schema.controlPlaneCommandReceipts.principal,principal));
      expect(retained.find(r=>r.requestId===ids[0])).toMatchObject({resultState:'expired',resultEnc:null});
      expect(retained.some(r=>r.requestId===ids[1])).toBe(false);
      expect(retained.find(r=>r.requestId===ids[2])).toMatchObject({resultState:'available'});
      await expect(plane.runtime.execute({principal,id:ids[0]!,kind:'fixture',payload:{},authorize(){throw new Error('revoked');},prepare(){throw new Error('must not execute');}})).rejects.toThrow('revoked');
      const clock=await coldClock(db,'receipts',Date.now(),policy);
      expect(clock.past).toBe(true); // Pending effect stays protected rather than repeatedly deleted.
      expect(await sweep('receipts')).toBe(0);
    } finally {
      await plane?.close();
      await db.delete(schema.controlPlaneOutbox).where(eq(schema.controlPlaneOutbox.id,effect));
      await db.delete(schema.controlPlaneCommandReceipts).where(eq(schema.controlPlaneCommandReceipts.principal,principal));
      await db.delete(schema.logs).where(eq(schema.logs.action,action));
      await pool.end();
    }
  });
  it('applies a shorter history policy to ended sessions while preserving live and pending sessions', async () => {
    const pool=mysql.createPool({...config!,connectionLimit:4}),db=drizzle(pool,{schema,mode:'default'}),keyring=testKeyring();
    const ids=[randomUUID(),randomUUID(),randomUUID()],old=new Date(Date.now()-3*3600000).toISOString(),future=new Date(Date.now()+86400000).toISOString(),now=new Date().toISOString();
    let hostId=0,plane:Awaited<ReturnType<typeof createOwnedControlPlane>>|undefined;
    try {
      const [host]=await db.insert(schema.hosts).values({fqdn:randomUUID()+'.test',apiKey:randomUUID(),secure:1,status:'active',engines:'codex,claude,grok',createdAt:now,updatedAt:now}).$returningId();hostId=host!.id;
      await db.insert(schema.agentSessions).values(ids.map((id,i)=>({id,hostId,engine:'codex',username:'root',cwd:'/fixture',invocationKind:'native',status:i===0?'active':'ended',hostAuthFingerprint:'0'.repeat(64),bridgeTokenHash:'0'.repeat(64),bridgeExpiresAt:future,startedAt:old,heartbeatAt:old,endedAt:i===0?null:old,expiresAt:future,createdAt:old,updatedAt:old})));
      await db.insert(schema.agentMessages).values({sessionId:ids[2]!,messageId:randomUUID(),clientMessageId:randomUUID(),contentEnc:encrypt('{}',keyring),status:'queued',nextAttemptAt:future,createdAt:old,updatedAt:old});
      const env={...loadTestEnv(),DB_DATABASE:String(config!.database)};
      plane=await createOwnedControlPlane({pool,handle:db,env,keyring,error(error){throw error;}});
      const previous=retentionStatus(db);
      await saveRetentionPolicy(db,{policy:{...previous.policy,history_hours:1},expected_revision:previous.revision});
      expect(plane.runtime.state.snapshot().sessions.get(ids[0]!)?.expiresAt).toBe(future);
      await runOwnerPortalRetention(db,plane.runtime,env,{key:'history:portal',revision:'test',dueAt:0});
      const retained=await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.hostId,hostId));
      expect(retained.map(r=>r.id).sort()).toEqual([ids[0],ids[2]].sort());
      expect(env.AGENT_PORTAL_RETENTION_HOURS).toBe(24);
      await expect(saveRetentionPolicy(db,{policy:previous.policy,expected_revision:previous.revision})).rejects.toMatchObject({code:'retention_policy_changed'});
      await saveRetentionPolicy(db,{policy:previous.policy,expected_revision:retentionStatus(db).revision});
    } finally {
      await plane?.close();
      await db.delete(schema.agentMessages).where(eq(schema.agentMessages.sessionId,ids[2]!));
      await db.delete(schema.agentSessions).where(eq(schema.agentSessions.hostId,hostId));
      await db.delete(schema.hosts).where(eq(schema.hosts.id,hostId));
      await pool.end();
    }
  });
});
