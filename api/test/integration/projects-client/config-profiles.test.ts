import { createHash } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agentsDocuments, clientConfigDocuments, type Host } from '../../../src/db/schema.js';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { registerProjectsClientRoutes } from '../../../src/routes/projects-client/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { createDbFake } from '../../helpers/db-fake.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const stamp = '2026-09-29T00:00:00Z';

async function buildApp(clientVersion: string | null) {
  const db = createDbFake();
  const host = { id: 1, fqdn: 'host.example', engines: 'codex', status: 'active', secure: 1, apiKey: 'host-key', clientVersion } as Host;
  db.tables.set(clientConfigDocuments, [{
    id: 1, engine: 'codex', body: '{}', sha256: digest('{}'), updatedAt: stamp,
    settings: { model: 'gpt-6-astra', profiles: [{ name: 'fast', model: 'gpt-6-luna', model_reasoning_effort: 'low' }] },
  }]);
  db.tables.set(agentsDocuments, []);
  const app = Fastify({ logger: false });
  await app.register(envelopePlugin);
  app.decorate('requireHost', async (request: FastifyRequest) => { request.authHost = host; });
  await registerProjectsClientRoutes(app, {
    db, env: { PUBLIC_BASE_URL: 'https://orchestrator.example' }, keyring: null,
  } as unknown as RouteContext);
  return app;
}

const retrieve = (app: Awaited<ReturnType<typeof buildApp>>, payload: object = {}) =>
  app.inject({ method: 'POST', url: '/config/retrieve?engine=codex', headers: { 'x-engine': 'codex' }, payload });

// The wrapper decodes this reply with a Go struct (orchestrator.ConfigBundle); this
// pins the live wire shape it reads, so a hand-written Go fixture cannot drift from it.
describe('POST /config/retrieve profile sidecars', () => {
  it('ships profiles beside the body, at the root and under data, for a current Codex', async () => {
    const app = await buildApp('0.158.0');
    try {
      const res = await retrieve(app);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.content).not.toContain('[profiles.');
      const expected = [{ name: 'fast', sha256: expect.any(String), content: 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n' }];
      expect(json.profiles).toEqual(expected);
      expect(json.data?.profiles).toEqual(expected);
    } finally {
      await app.close();
    }
  });

  it('keeps sending profiles when the body is unchanged, so pruning and repair keep working', async () => {
    const app = await buildApp('0.158.0');
    try {
      const first = (await retrieve(app)).json();
      const again = (await retrieve(app, { sha256: first.sha256 })).json();
      expect(again.status).toBe('unchanged');
      expect(again.content).toBeUndefined();
      expect(again.profiles).toEqual(first.profiles);
    } finally {
      await app.close();
    }
  });

  it('sends no profiles key to a Codex that still reads [profiles.*] from config.toml', async () => {
    const app = await buildApp('0.155.0');
    try {
      const json = (await retrieve(app)).json();
      expect(json.content).toContain('[profiles.fast]');
      expect(json).not.toHaveProperty('profiles');
    } finally {
      await app.close();
    }
  });
});
