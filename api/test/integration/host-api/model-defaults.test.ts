import { describe, expect, it, vi } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments, hosts, logs, versions } from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { ModelDefaultsService } from '../../../src/services/model-defaults.js';

// DbFake has no prepared SQL support. Replace only that SQL read; host status,
// expiry, IP binding, insecure-window and engine admission still run normally.
vi.mock('../../../src/services/host-auth-admission.js', () => ({
  readTransportAdmission: async (db: ReturnType<typeof createDbFake>, hash: string, raw: string) => {
    const host = db.tables.get(hosts)?.find(row => row.apiKeyHash === hash || row.apiKey === raw);
    if (!host) return null;
    const flag = (name: string) => db.tables.get(versions)?.find(row => row.name === name)?.version;
    return { host, apiDisabled: flag('api_disabled') === '1', reverseDnsDefault: false };
  },
}));

const key = 'selector-host-test-key';
const headers = { 'x-api-key': key };
const env = {
  INSTALLATION_ID: 'test', ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  PUBLIC_BASE_URL: 'https://fleet.example', STATIC_ROOT: '', INSECURE_GRACE_MINUTES: 60,
} as Parameters<typeof buildHostApiTestApp>[0]['env'];

async function setup(hostFields: Record<string, unknown> = {}, settings: Record<string, string> = {}) {
  const db = createDbFake();
  db.tables.set(hosts, [{
    id: 1, fqdn: 'selector.example', apiKey: key, apiKeyHash: hashApiKey(key),
    status: 'active', secure: 1, vip: 0, engines: 'codex,claude,grok,kimi',
    allowRoamingIps: 0, reverseDnsMode: null, ip4: null, ip6: null, expiresAt: null,
    modelOverride: 'gpt-6.1-sol', reasoningEffortOverride: 'high',
    insecureEnabledUntil: null, insecureGraceUntil: null, ...hostFields,
  }]);
  db.tables.set(versions, Object.entries(settings).map(([name, version]) => ({ name, version, updatedAt: new Date().toISOString() })));
  const app = await buildHostApiTestApp({ db: db as never, env, keyring: Keyring.fromEnv(env) });
  return { app, db };
}

const choices = [
  ['codex', 'gpt-6.2-astra', 'ultra'],
  ['claude', 'claude-fable-5-2', 'high'],
  ['grok', 'grok-4.7', 'xhigh'],
  ['kimi', 'k3.1-pro', 'high'],
] as const;

describe('host fleet model defaults', () => {
  it.each(choices)('lets a non-VIP host save and reload %s model/effort, retaining overrides', async (engine, model, effort) => {
    const { app, db } = await setup();
    try {
      const initial = await app.inject({ method: 'GET', url: `/host/model-defaults/${engine}`, headers });
      expect(initial.statusCode).toBe(200);
      expect(db.tables.get(clientConfigDocuments) ?? []).toHaveLength(0);
      const response = await app.inject({ method: 'POST', url: `/host/model-defaults/${engine}`, headers,
        payload: { model, reasoning_effort: effort } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ engine, model, reasoning_effort: effort });
      const loaded = await app.inject({ method: 'GET', url: `/host/model-defaults/${engine}`, headers });
      expect(loaded.json()).toMatchObject({ engine, model, reasoning_effort: effort });
      expect(await new ModelDefaultsService(db as never).get(engine)).toMatchObject({ model, reasoning_effort: effort });
      expect(db.tables.get(clientConfigDocuments)!.at(-1)).toMatchObject({ sourceHostId: 1, engine });
      expect(db.tables.get(hosts)![0]).toMatchObject({ modelOverride: 'gpt-6.1-sol', reasoningEffortOverride: 'high' });
      expect(db.tables.get(logs)).toEqual(expect.arrayContaining([expect.objectContaining({ hostId: 1, action: 'host.model_defaults.set',
        details: expect.stringContaining(`"model":"${model}"`) })]));
    } finally { await app.close(); }
  });

  it.each(['GET', 'POST'] as const)('requires host auth for %s', async method => {
    const { app } = await setup();
    try {
      const response = await app.inject({ method, url: '/host/model-defaults/codex',
        ...(method === 'POST' ? { payload: { model: 'gpt-6.2-astra', reasoning_effort: 'low' } } : {}) });
      expect(response.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it.each([
    [{ status: 'disabled' }, {}, 'codex', 403],
    [{ expiresAt: '2000-01-01T00:00:00Z' }, {}, 'codex', 401],
    [{ engines: 'claude' }, {}, 'codex', 403],
    [{ secure: 0 }, {}, 'codex', 423],
    [{ ip4: '192.0.2.5' }, {}, 'codex', 401],
    [{}, { codex_engine_disabled: '1' }, 'codex', 403],
    [{}, { api_disabled: '1' }, 'codex', 403],
    [{}, {}, 'invalid', 422],
  ] as const)('rejects inadmissible hosts/engines (%j, %j, %s)', async (host, flags, engine, status) => {
    const { app, db } = await setup(host, flags);
    try {
      const response = await app.inject({ method: 'POST', url: `/host/model-defaults/${engine}`, headers,
        payload: { model: 'gpt-6.2-astra', reasoning_effort: 'low' } });
      expect(response.statusCode, response.body).toBe(status);
      expect(db.tables.get(clientConfigDocuments) ?? []).toHaveLength(0);
    } finally { await app.close(); }
  });

  it.each([
    { model: 'gpt-6.2-astra' },
    { model: 'missing-model', reasoning_effort: 'low' },
    { model: 'gpt-6.2-astra', reasoning_effort: 'minimal' },
    { model: 'gpt-6.2-astra', reasoning_effort: 'low', context_window: 500000 },
    { model: 'gpt-6.2-astra', reasoning_effort: 'low', engine: 'claude' },
  ])('rejects invalid payload without a write (%j)', async payload => {
    const { app, db } = await setup();
    try {
      const response = await app.inject({ method: 'POST', url: '/host/model-defaults/codex', headers, payload });
      expect(response.statusCode).toBe(422);
      expect(db.tables.get(clientConfigDocuments) ?? []).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('rejects session-only Claude max', async () => {
    const { app, db } = await setup();
    try {
      const response = await app.inject({ method: 'POST', url: '/host/model-defaults/claude', headers,
        payload: { model: 'claude-fable-5-2', reasoning_effort: 'max' } });
      expect(response.statusCode).toBe(422);
      expect(db.tables.get(clientConfigDocuments) ?? []).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('persists null effort for a model without reasoning', async () => {
    const { app } = await setup();
    try {
      const response = await app.inject({ method: 'POST', url: '/host/model-defaults/claude', headers,
        payload: { model: 'claude-haiku-4-5-20251001', reasoning_effort: null } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ model: 'claude-haiku-4-5-20251001', reasoning_effort: null });
    } finally { await app.close(); }
  });

  it('rejects conflicting engine hints', async () => {
    const { app } = await setup();
    try {
      const response = await app.inject({ method: 'GET', url: '/host/model-defaults/claude', headers: { ...headers, 'x-engine': 'codex' } });
      expect(response.statusCode).toBe(422);
    } finally { await app.close(); }
  });

  it('reports the effective latest-family selection', async () => {
    const { app } = await setup({}, { codex_models_latest_only: '1' });
    try {
      const response = await app.inject({ method: 'POST', url: '/host/model-defaults/codex', headers,
        payload: { model: 'gpt-6-astra', reasoning_effort: 'high' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ model: 'gpt-6.2-astra', stored_model: 'gpt-6-astra', reasoning_effort: 'high' });
    } finally { await app.close(); }
  });
});
