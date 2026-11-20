import { createHash } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { skills, type Host } from '../../../src/db/schema.js';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { registerProjectsClientRoutes } from '../../../src/routes/projects-client/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { createDbFake } from '../../helpers/db-fake.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const stamp = '2026-09-07T00:00:00Z';

async function buildApp(engines = 'codex,claude') {
  const db = createDbFake();
  const host = { id: 1, fqdn: 'host.example', engines, status: 'active', secure: 1, apiKey: 'host-key' } as Host;
  db.tables.set(skills, ['codex', 'claude'].map((engine, index) => ({
    id: index + 1, slug: `${engine}-skill`, engine,
    manifest: `${engine} instructions`, sha256: digest(`${engine} instructions`),
    displayName: `${engine} skill`, deletedAt: null, updatedAt: stamp,
  })));
  const app = Fastify({ logger: false });
  await app.register(envelopePlugin);
  app.decorate('requireHost', async (request: FastifyRequest) => { request.authHost = host; });
  await registerProjectsClientRoutes(app, {
    db, env: { PUBLIC_BASE_URL: 'https://orchestrator.example' }, keyring: null,
  } as unknown as RouteContext);
  return { app };
}

describe('host engine routing for the skill list', () => {
  it.each([
    { headers: { 'x-engine': 'claude' }, query: '' },
    { headers: { 'user-agent': 'clx/2.0.0' }, query: '' },
    { headers: {}, query: '?engine=claude' },
  ])('serves the Claude list with header, query or legacy wrapper identity', async ({ headers, query }) => {
    const { app } = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: `/skills${query}`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('claude-skill');
      expect(response.body).not.toContain('codex-skill');
    } finally {
      await app.close();
    }
  });

  it('rejects contradictory hints', async () => {
    const { app } = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/skills?engine=codex', headers: { 'x-engine': 'claude' } });
      expect(response.statusCode).toBe(422);
      expect(response.body).toContain('conflicting engine hints');
    } finally {
      await app.close();
    }
  });

  it('enforces host engine eligibility for a header-selected engine', async () => {
    const { app } = await buildApp('codex');
    try {
      const response = await app.inject({ method: 'GET', url: '/skills', headers: { 'x-engine': 'claude' } });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('engine_disabled');
    } finally {
      await app.close();
    }
  });

  it.each(['/skills/retrieve', '/skills/store', '/agents/retrieve', '/config/retrieve', '/claude/agents/retrieve'])(
    'no longer serves the pre-bundle POST %s',
    async (url) => {
      const { app } = await buildApp();
      try {
        expect((await app.inject({ method: 'POST', url, headers: { 'x-engine': 'claude' }, payload: {} })).statusCode).toBe(404);
      } finally {
        await app.close();
      }
    },
  );
});
