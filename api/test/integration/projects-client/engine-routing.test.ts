import { createHash } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agentsDocuments, claudeArtifacts, clientConfigDocuments, skills, type Host } from '../../../src/db/schema.js';
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
  db.tables.set(clientConfigDocuments, ['codex', 'claude'].map((engine, index) => ({
    id: index + 1, engine, body: '{}', sha256: digest('{}'),
    settings: { model: engine === 'codex' ? 'gpt-5.6-terra' : 'claude-opus-5' },
    updatedAt: stamp,
  })));
  db.tables.set(agentsDocuments, [{ id: 1, engine: 'codex', body: 'Shared fleet instructions', sha256: digest('Shared fleet instructions'), updatedAt: stamp }]);
  db.tables.set(claudeArtifacts, [{
    id: 1, kind: 'subagent', slug: 'reviewer', engine: 'claude', body: 'Review changes',
    sha256: digest('Review changes'), deletedAt: null, updatedAt: stamp,
  }]);
  const app = Fastify({ logger: false });
  await app.register(envelopePlugin);
  app.decorate('requireHost', async (request: FastifyRequest) => { request.authHost = host; });
  await registerProjectsClientRoutes(app, {
    db, env: { PUBLIC_BASE_URL: 'https://orchestrator.example' }, keyring: null,
  } as unknown as RouteContext);
  return { app, db };
}

describe('host engine routing for synced resources', () => {
  it.each([
    { headers: { 'x-engine': 'claude' }, query: '' },
    { headers: { 'user-agent': 'clx/2.0.0' }, query: '' },
    { headers: {}, query: '?engine=claude' },
  ])('serves Claude resources with header, query or legacy wrapper identity', async ({ headers, query }) => {
    const { app } = await buildApp();
    try {
      const skill = await app.inject({ method: 'POST', url: `/skills/retrieve${query}`, headers, payload: { slug: 'claude-skill' } });
      expect(skill.statusCode).toBe(200);
      expect(skill.json()).toMatchObject({ status: 'updated', slug: 'claude-skill' });
      const config = await app.inject({ method: 'POST', url: `/config/retrieve${query}`, headers, payload: {} });
      expect(config.statusCode).toBe(200);
      expect(config.json().engine).toBe('claude');
      expect(JSON.parse(config.json().content)).toMatchObject({ model: 'claude-opus-5' });
      expect(config.json().content).not.toContain('gpt-5.6-terra');
      const agents = await app.inject({ method: 'POST', url: `/agents/retrieve${query}`, headers, payload: {} });
      expect(agents.statusCode).toBe(200);
      expect(agents.json().engine).toBe('claude');
      expect(agents.json().content).toContain('Shared fleet instructions');
    } finally {
      await app.close();
    }
  });

  it('filters skill lists using the requested engine header', async () => {
    const { app } = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/skills', headers: { 'x-engine': 'claude' } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('claude-skill');
      expect(response.body).not.toContain('codex-skill');
    } finally {
      await app.close();
    }
  });

  it.each(['/skills/retrieve', '/skills/store', '/agents/retrieve', '/config/retrieve'])('rejects contradictory hints on %s', async (url) => {
    const { app } = await buildApp();
    try {
      const response = await app.inject({ method: 'POST', url, headers: { 'x-engine': 'claude' }, payload: { engine: 'codex' } });
      expect(response.statusCode).toBe(422);
      expect(response.body).toContain('conflicting engine hints');
    } finally {
      await app.close();
    }
  });

  it('enforces host engine eligibility for header-selected configuration', async () => {
    const { app } = await buildApp('codex');
    try {
      const response = await app.inject({ method: 'POST', url: '/config/retrieve', headers: { 'x-engine': 'claude' }, payload: {} });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('engine_disabled');
    } finally {
      await app.close();
    }
  });
});

describe('Claude-native artifacts', () => {
  it('defaults list and retrieval to Claude on Claude-only hosts', async () => {
    const { app } = await buildApp('claude');
    try {
      const list = await app.inject({ method: 'GET', url: '/claude/agents' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ engine: 'claude', items: [{ slug: 'reviewer' }] });
      const result = await app.inject({ method: 'POST', url: '/claude/agents/retrieve', payload: { slug: 'reviewer' } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ status: 'updated', content: 'Review changes' });
    } finally {
      await app.close();
    }
  });

  it('rejects explicit Codex hints for both list and retrieval', async () => {
    const { app } = await buildApp();
    try {
      const list = await app.inject({ method: 'GET', url: '/claude/agents?engine=codex' });
      const result = await app.inject({ method: 'POST', url: '/claude/agents/retrieve', headers: { 'x-engine': 'codex' }, payload: { slug: 'reviewer' } });
      expect(list.statusCode).toBe(422);
      expect(result.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });
});
