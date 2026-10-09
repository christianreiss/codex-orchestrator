import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAdminGitDirectorRoutes } from '../../../src/routes/admin/git-director/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { adminEvents, versions } from '../../../src/db/schema.js';
import { GIT_COMMIT_SETTINGS_KEY } from '../../../src/services/git-commit-settings.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';

const url = '/admin/git-director/commit-settings';
const apps: Array<ReturnType<typeof Fastify>> = [];
async function buildApp(role: string | null, db: DbFake = createDbFake()) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(envelopePlugin);
  await registerCapabilityStack(app, { role });
  await registerAdminGitDirectorRoutes(app, { db, env: {} } as unknown as RouteContext);
  return { app, db };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('fleet commit settings', () => {
  it('reads defaults without inserting a row or enabling the Director', async () => {
    const { app, db } = await buildApp('viewer');
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ message_style: 'short', ai_attribution: false });
    expect(db.inserts).toHaveLength(0);
  });

  it('persists both fields, audits the actor and emits cross-tab invalidation', async () => {
    const { app, db } = await buildApp('owner');
    const publish = vi.spyOn(wsPublisher, 'publish');
    for (const payload of [
      { message_style: 'long', ai_attribution: true },
      { message_style: 'short', ai_attribution: false },
    ]) {
      const res = await app.inject({ method: 'POST', url, payload });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual(payload);
      expect((await app.inject({ method: 'GET', url })).json().data).toEqual(payload);
      expect(db.tables.get(adminEvents)?.at(-1)).toMatchObject({
        type: 'git_director.commit_settings_updated',
        payload: { ...payload, admin_user_id: 7 },
      });
    }
    expect(db.tables.get(versions)).toHaveLength(1);
    expect(publish).toHaveBeenCalledWith('settings.changed', { key: GIT_COMMIT_SETTINGS_KEY });
  });

  it.each([
    {}, { message_style: 'medium', ai_attribution: false },
    { message_style: 'short', ai_attribution: 'false' },
    { message_style: 'short', ai_attribution: false, engine: 'codex' },
  ])('rejects invalid settings before writing: %j', async (payload) => {
    const { app, db } = await buildApp('owner');
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
    expect(db.inserts).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });

  it.each([null, 'viewer'])('refuses mutations for role %s before writing', async (role) => {
    const { app, db } = await buildApp(role);
    const res = await app.inject({ method: 'POST', url, payload: { message_style: 'long', ai_attribution: true } });
    expect(res.statusCode).toBe(role === null ? 401 : 403);
    expect(db.inserts).toHaveLength(0);
  });

  it('requires authentication for reads', async () => {
    const { app } = await buildApp(null);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it.each(['{', '{"message_style":"unknown","ai_attribution":true}'])('uses documented defaults for invalid stored data', async (version) => {
    const db = createDbFake(new Map([[versions, [{ name: GIT_COMMIT_SETTINGS_KEY, version }]]]));
    const { app } = await buildApp('owner', db);
    expect((await app.inject({ method: 'GET', url })).json().data).toEqual({ message_style: 'short', ai_attribution: false });
    expect(db.updates).toHaveLength(0);
  });
});
