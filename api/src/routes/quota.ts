import {persistAuditLog} from '../services/audit-log.js';
import { ownerRuntimeFor, mutateOwnerState } from '../control-plane/state/runtime.js';
import { stageDelete } from '../control-plane/state/rows.js';
import { ChatGptUsageService } from '../services/chatgpt-usage.js';
import { GrokUsageService } from '../services/grok-usage.js';
import { createGrokAuthOwner } from '../services/grok-auth-owner.js';
import { createRunnerClient } from '../services/runner-client.js';
import { wsPublisher } from '../ws/publisher.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { SettingsService } from '../services/settings.js';
import { quotaPolicySchema, quotaPolicyKey, readQuotaPolicy } from '../services/quota-policy.js';
import { quotaSnapshot } from '../services/quota-observation.js';
import { ProviderAccountsService } from '../services/provider-accounts.js';
import { WatchdogsService } from '../services/watchdogs.js';
import { parseEngine, type Engine } from '../util/engine.js';
import { versions } from '../db/schema.js';

export async function registerQuotaRoutes(app: FastifyInstance, ctx: RouteContext) {
  const settings = new SettingsService(ctx.db);
  const accounts = new ProviderAccountsService(ctx.db, ctx.keyring);
  const resolve = async (params: unknown) => {
    const p = z.object({ engine: z.string().optional(), id: z.coerce.number().int().positive().optional() }).parse(params);
    if (p.id) { const account = await accounts.get(p.id); return { engine: account.engine as Engine, id: account.id }; }
    return { engine: parseEngine(p.engine), id: undefined };
  };
  const getPolicy = async (req: FastifyRequest) => {
    const { engine, id } = await resolve(req.params);
    return readQuotaPolicy(ctx.db, engine, id);
  };
  const putPolicy = async (req: FastifyRequest) => {
    const { engine, id } = await resolve(req.params);
    const input = z.object({ policy: quotaPolicySchema.nullable() }).strict().parse(req.body);
    const key = quotaPolicyKey(engine, id);
    const owner=ownerRuntimeFor(ctx.db);
    if(owner){
      await mutateOwnerState(owner,{kind:'quota.policy.update',payload:{engine,accountId:id??null,policy:input.policy},prepare(command){
        if(id&&command.snapshot.table('providerAccounts').get(id)?.engine!==engine)throw new Error('Quota account changed');
        const now=new Date().toISOString();
        if(input.policy===null)stageDelete(command,'versions',key);
        else{const row={name:key,version:JSON.stringify(input.policy),updatedAt:now};command.draft.upsert('versions',row);command.write(tx=>tx.insert(versions).values(row).onDuplicateKeyUpdate({set:{version:row.version,updatedAt:now}}));}
        command.write(tx=>persistAuditLog(tx, {action:'quota.policy.updated',details:JSON.stringify({engine,account_id:id??null,policy:input.policy}),createdAt:now}));return null;
      }});
      wsPublisher.publish('quota.policy.updated',{engine,account_id:id??null});
      return readQuotaPolicy(ctx.db,engine,id);
    }
    if (input.policy === null) await ctx.db.delete(versions).where(eq(versions.name, key));
    else await settings.set(key, JSON.stringify(input.policy));
    await persistAuditLog(ctx.db, { action: 'quota.policy.updated', details: JSON.stringify({ engine, account_id: id ?? null, policy: input.policy }), createdAt: new Date().toISOString() });
    wsPublisher.publish('quota.policy.updated', { engine, account_id: id ?? null });
    return readQuotaPolicy(ctx.db, engine, id);
  };
  app.get('/admin/quota-policy/:engine', { preHandler: app.requireAdmin }, getPolicy);
  app.put('/admin/quota-policy/:engine', { preHandler: app.requireAdmin }, putPolicy);
  app.get('/admin/accounts/:id/quota-policy', { preHandler: app.requireAdmin }, getPolicy);
  app.put('/admin/accounts/:id/quota-policy', { preHandler: app.requireAdmin }, putPolicy);
  app.post('/host/agent-sessions/:id/agent-messaging/quota/get', async req => {
    z.object({}).strict().parse(req.body);
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const token = z.string().min(1).parse(req.headers['x-agent-bridge-token']);
    const session = await new WatchdogsService(ctx.db, ctx.keyring).bridge(id, token);
    if (!session.providerAccountId) return { status: 'unavailable', reason: 'account_binding_unknown', short: null, long: null };
    if (session.engine === 'codex') {
      await new ChatGptUsageService(ctx.db, app.log, { env: ctx.env, keyring: ctx.keyring, accountId: session.providerAccountId }).fetchLatest(false).catch(() => undefined);
    } else if (session.engine === 'grok') {
      await new GrokUsageService({ db: ctx.db, authOwner: createGrokAuthOwner({ db: ctx.db, keyring: ctx.keyring, runner: createRunnerClient({ env: ctx.env }) }) }).refreshAccount(session.providerAccountId).catch(() => undefined);
    }
    return await quotaSnapshot(ctx.db, session.providerAccountId, session.engine as Engine) ?? { status: 'unavailable', reason: 'account_unavailable', short: null, long: null };
  });
}
