import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentBusMessages } from '../../../src/db/schema.js';
import { resetEnvCache } from '../../../src/env.js';
import { buildServer } from '../../../src/server.js';
import {
  createIsolatedTestDb,
  isolatedDbSetupTimeoutMs,
  isolatedDbTeardownTimeoutMs,
  readDbConfig,
} from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const config = readDbConfig();

describe.skipIf(!config)('OAuth connector delegation on MySQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDb>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDb('connector');
  }, isolatedDbSetupTimeoutMs);
  afterAll(async () => {
    await isolated?.close();
  }, isolatedDbTeardownTimeoutMs);
  it('queues OAuth delegation as one durable work request and returns only recorded results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'connector-delegate-'));
    const issuer = 'https://connector.fixture.test';
    const callback = 'https://client.fixture.test/callback';
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    try {
      testKeyring();
      for (const [key, value] of Object.entries({
        DB_HOST: String(config!.host),
        DB_PORT: String(config!.port),
        DB_USERNAME: String(config!.user),
        DB_PASSWORD: String(config!.password),
        DB_DATABASE: isolated.database,
        DATA_ROOT: root,
        PUBLIC_BASE_URL: issuer,
        CONNECTOR_PUBLIC_BASE_URL: issuer,
        AUTH_RUNNER_URL: '',
        AUTH_RUNNER_SHARED_SECRET: '',
        RUN_MIGRATIONS_ON_BOOT: '1',
        MIGRATIONS_DIR: join(process.cwd(), 'src/db/migrations'),
      }))
        vi.stubEnv(key, value);
      resetEnvCache();
      app = await buildServer();
      const server = app;
      const setup = await server.inject({
        method: 'POST',
        url: '/admin/setup/owner',
        payload: {
          username: 'fixture-owner',
          name: 'Test Owner',
          email: 'owner@fixture.test',
          password: randomBytes(32).toString('base64url'),
        },
      });
      expect(setup.statusCode).toBeLessThan(300);
      const headers = { cookie: setup.cookies.map((c) => c.name + '=' + c.value).join('; '), origin: issuer };
      async function post(url: string, payload: Record<string, unknown>, method: 'PUT' | 'POST' = 'POST') {
        const result = await server.inject({ method, url, headers, payload });
        expect(result.statusCode, url).toBeLessThan(300);
        const json = result.json();
        return json.data ?? json;
      }
      const { host } = await post('/admin/hosts/register', {
        fqdn: 'recipient.fixture.test',
        secure: true,
        vip: true,
        engines: ['codex'],
        reverse_dns_mode: 'disabled',
      });
      await post('/admin/agent-messaging/state', { enabled: true });
      const sessionId = randomUUID();
      const registered = await server.inject({
        method: 'POST',
        url: '/host/agent-sessions',
        headers: { 'x-api-key': host.api_key },
        payload: {
          session_id: sessionId,
          upstream_session_id: randomUUID(),
          engine: 'codex',
          bridge_token: randomBytes(32).toString('base64url'),
          username: 'fixture',
          cwd: root,
          invocation_kind: 'interactive',
          adapter_capabilities: { execution_contract_version: 2 },
        },
      });
      expect(registered.json().data.enabled).toBe(true);
      const scope = { categories: { coordination: 'rw' }, hosts: [host.id], sensitive: ['delegate'] };
      await post(
        '/admin/connectors/config',
        {
          enabled: true,
          providers: { chatgpt: true, claude: false, grok: false, kimi: false },
          ceiling: scope,
        },
        'PUT',
      );
      const client = await post('/oauth/register?provider=chatgpt', { redirect_uris: [callback] });
      const verifier = randomBytes(48).toString('base64url');
      const auth = await server.inject({
        method: 'GET',
        url: '/oauth/authorize',
        query: {
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: callback,
          resource: issuer + '/connectors/mcp',
          code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        },
      });
      expect(auth.statusCode).toBe(302);
      const requestId = new URL(String(auth.headers.location), issuer).searchParams.get('request');
      const consent = '/admin/connectors/consent/' + requestId;
      const { csrf } = (await server.inject({ url: consent, headers })).json().data;
      const { redirect } = await post(consent, { approve: true, scope, csrf });
      const token = await server.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          redirect_uri: callback,
          code_verifier: verifier,
          code: new URL(redirect).searchParams.get('code')!,
        }).toString(),
      });
      expect(token.statusCode).toBe(200);
      async function call(name: string, args: Record<string, unknown>) {
        const response = await server.inject({
          method: 'POST',
          url: '/connectors/mcp',
          headers: { authorization: 'Bearer ' + token.json().access_token },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().error, name).toBeUndefined();
        return JSON.parse(response.json().result.content[0].text);
      }
      const args = {
        client_message_id: randomUUID(),
        host_id: host.id,
        session_id: sessionId,
        content: 'Observe test fixture.',
      };
      const { message } = await call('agent_delegate', args);
      expect((await call('agent_delegate', args)).message.id).toBe(message.id);
      const rows = await server.db
        .select()
        .from(agentBusMessages)
        .where(eq(agentBusMessages.clientMessageId, args.client_message_id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: message.id,
        kind: 'request',
        deliveryClass: 'information',
        deliveryTiming: 'after_turn',
        status: 'queued',
      });
      expect(rows[0]?.connectorGrantId).toBeTruthy();
      expect(await call('work_result', { message_id: message.id })).toEqual({
        message_id: message.id,
        delivery_status: 'queued',
        results: [],
      });
    } finally {
      await app?.close();
      vi.unstubAllEnvs();
      resetEnvCache();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
