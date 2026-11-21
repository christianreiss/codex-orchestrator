import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RowDataPacket } from 'mysql2';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../../../src/env.js';
import { buildServer } from '../../../src/server.js';
import {
  createIsolatedTestDb,
  isolatedDbSetupTimeoutMs,
  isolatedDbTeardownTimeoutMs,
  readDbConfig,
} from '../../helpers/test-db.js';

type ClientSocket = Awaited<ReturnType<FastifyInstance['injectWS']>>;
const WebSocket = createRequire(import.meta.url)('ws') as new (
  url: string,
  options: { headers: Record<string, string> },
) => ClientSocket;
const config = readDbConfig();

// This gate creates and owns a new schema. The supplied test database is never modified.
describe.skipIf(!config)('admin content reaches a host over production HTTP, MCP and admin WS', () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedTestDb>>;
  beforeAll(async () => {
    fixture = await createIsolatedTestDb('work');
  }, isolatedDbSetupTimeoutMs);
  afterAll(async () => { await fixture?.close(); }, isolatedDbTeardownTimeoutMs);

  it('publishes committed changes, survives owner restart, and fences deleted content and revoked sessions', async () => {
    // Only synthetic credentials and a newly-created schema enter the owner.
    const { database: schema, pool: sql } = fixture;
    const issuer = 'https://wire.fixture.invalid';
    const root = await mkdtemp(join(tmpdir(), 'orchestrator-work-wire-'));
    let owner: Awaited<ReturnType<typeof buildServer>> | undefined;
    let ws: ClientSocket | undefined;
    let communicator: ClientSocket | undefined;
    let base = '',
      cookie = '',
      hostKey = '';
    const events: { type: string; payload?: { slug?: string } }[] = [];
    const hostHeaders = () => ({ 'x-api-key': hostKey, 'x-engine': 'codex' });
    async function start() {
      owner = await buildServer();
      base = await owner.listen({ host: '127.0.0.1', port: 0 });
      expect(owner.controlPlane.ownership.status()).toBe('ready');
    }
    async function request<T>(
      path: string,
      method = 'GET',
      body?: unknown,
      credential = { cookie } as Record<string, string>,
      status = 200,
    ) {
      const response = await fetch(base + path, {
        method,
        headers: {
          accept: 'application/json',
          ...credential,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = (await response.json()) as { code?: string; data?: T };
      expect(response.status, method + ' ' + path + ' ' + (json.code ?? '')).toBe(status);
      if (path === '/admin/setup/owner') cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
      return (json.data ?? json) as T;
    }
    async function tool(name: string, args: Record<string, unknown>, error = false) {
      const reply = await request<{
        error?: unknown;
        result?: { isError?: boolean; content: { text: string }[] };
      }>(
        '/mcp',
        'POST',
        { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } },
        hostHeaders(),
      );
      if (error) {
        expect(Boolean(reply.error || reply.result?.isError), name).toBe(true);
        return '';
      }
      expect(reply.error, name).toBeUndefined();
      expect(reply.result?.isError, name).not.toBe(true);
      return reply.result!.content.map((entry) => entry.text).join('\n');
    }
    try {
      for (const [key, value] of Object.entries({
        DB_HOST: String(config!.host),
        DB_PORT: String(config!.port || 3306),
        DB_USERNAME: String(config!.user),
        DB_PASSWORD: String(config!.password ?? ''),
        DB_DATABASE: schema,
        DATA_ROOT: root,
        AUTH_RUNNER_URL: '',
        AUTH_RUNNER_SHARED_SECRET: '',
        ADMIN_WS_ENABLED: '1',
        CXX_COMMUNICATOR_ENABLED: '1',
        ENCRYPTION_ACTIVE_KEY: randomBytes(32).toString('base64'),
        PUBLIC_BASE_URL: issuer,
        CONNECTOR_PUBLIC_BASE_URL: issuer,
        MIGRATIONS_DIR: resolve('src/db/migrations'),
        RUN_MIGRATIONS_ON_BOOT: '1',
        LOG_LEVEL: 'silent',
      }))
        vi.stubEnv(key, value);
      resetEnvCache();
      await start();
      await request('/admin/setup/owner', 'POST', {
        username: 'fixture',
        name: 'Test owner',
        email: 'wire@fixture.invalid',
        password: randomBytes(24).toString('hex'),
      });
      const defaults = await request<{ model: string; reasoning_effort: string | null }>(
        '/admin/model-defaults/codex',
      );
      await request('/admin/model-defaults/codex', 'POST', {
        model: defaults.model,
        reasoning_effort: defaults.reasoning_effort,
      });
      const registered = await request<{ host: { api_key: string; id: number } }>(
        '/admin/hosts/register',
        'POST',
        {
          fqdn: 'wire.fixture.invalid',
          engines: ['codex'],
          secure: true,
          reverse_dns_mode: 'disabled',
        },
      );
      hostKey = registered.host.api_key;
      ws = new WebSocket(base.replace('http:', 'ws:') + '/admin/ws', { headers: { cookie } });
      ws.on('message', (bytes: Buffer) => events.push(JSON.parse(bytes.toString())));
      await vi.waitFor(() => expect(events.some((event) => event.type === 'hello')).toBe(true));

      // Operator edits must reach host resources and the browser notification channel.
      const slug = 'wire-skill';
      const manifest = (v: number) =>
        '---\nname: wire-skill\ndescription: Fixture skill\n---\n\nSkill content ' + v + '\n';
      await request('/admin/skills/store', 'POST', { slug, manifest: manifest(1) });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === 'skill.stored' && event.payload?.slug === slug)).toBe(
          true,
        ),
      );
      expect(JSON.parse(await tool('skill_retrieve', { slug })).manifest).toBe(manifest(1));
      await request('/admin/skills/store', 'POST', { slug, manifest: manifest(2) });
      const rules = '# Managed fixture rules\n\nRetain the fixture version.\n';
      await request('/admin/agents/store', 'POST', { engine: 'codex', content: rules });
      const bootstrap = await request<{ agents: { content: string } }>(
        '/sync/bootstrap',
        'POST',
        { engine: 'codex', include_auth: false },
        hostHeaders(),
      );
      expect(bootstrap.agents.content).toContain('Retain the fixture version.');

      await request('/admin/projects/state', 'POST', { enabled: true });
      await request('/admin/projects', 'POST', { slug: 'wire-project', about: { purpose: 'Scope fixture' } });
      const projectFile = await request<{ file: { id: number } }>(
        '/admin/projects/wire-project/files',
        'POST',
        { stored_name: 'notes.txt', content: 'Wire artifact' },
      );
      const projectFilePath = '/admin/projects/wire-project/files/' + projectFile.file.id;
      expect(JSON.stringify(await request(projectFilePath))).toContain('Wire artifact');
      await request('/admin/project-board/state', 'POST', { enabled: true });
      await request('/admin/projects/wire-project/board/cards', 'POST', { title: 'Review fixture artifact' });
      expect(JSON.stringify(await request('/admin/projects/wire-project/board'))).toContain(
        'Review fixture artifact',
      );
      await request('/admin/secrets/state', 'POST', { enabled: true });
      const secret = randomUUID();
      const entry = await request<{ secret: { id: number } }>(
        '/admin/secrets',
        'POST',
        { slug: 'wire-secret', name: 'Fixture secret', value: secret },
        { cookie },
        201,
      );
      expect(JSON.stringify(await request('/admin/secrets'))).not.toContain(secret);
      expect(JSON.parse(await tool('secret_get', { slug: 'wire-secret' })).value).toBe(secret);

      const memorySlug = 'wire.shared';
      await tool('shared_memory_write', { slug: memorySlug, content: 'Initial shared note' });
      const first = JSON.parse(await tool('shared_memory_read', { slug: memorySlug }));
      expect(first.content).toBe('Initial shared note');
      await tool('shared_memory_write', {
        slug: memorySlug,
        content: 'Revised shared note',
        expected_sha256: first.memory.sha256,
      });
      await tool(
        'shared_memory_write',
        { slug: memorySlug, content: 'Stale edit', expected_sha256: first.memory.sha256 },
        true,
      );
      expect(JSON.parse(await tool('shared_memory_read', { slug: memorySlug })).content).toBe(
        'Revised shared note',
      );
      expect(await tool('project_file_read', { slug: 'wire-project', id: projectFile.file.id })).toContain(
        'Wire artifact',
      );
      const bytes = Buffer.from([0, 42, 128, 255]);
      await request('/admin/transfers/state', 'POST', { enabled: true });
      const put = JSON.parse(
        await tool('transfer_put', {
          name: 'fixture.bin',
          content_b64: bytes.toString('base64'),
          ttl_seconds: 300,
        }),
      );
      const transfer = JSON.parse(await tool('transfer_get', { id: put.transfer.id }));
      expect(Buffer.from(transfer.content_b64, 'base64')).toEqual(bytes);
      expect(transfer.transfer.content_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

      // This simulates the connector's OAuth client locally. Never follow its callback.
      const browserHeaders = { cookie, origin: issuer };
      const scope = { categories: { hosts: 'ro' }, hosts: [registered.host.id] };
      await request(
        '/admin/connectors/config',
        'PUT',
        {
          enabled: true,
          providers: { chatgpt: true, claude: true, grok: true, kimi: true },
          ceiling: scope,
        },
        browserHeaders,
      );
      const redirectUri = 'https://client.fixture.invalid/callback';
      const client = await request<{ client_id: string }>(
        '/oauth/register?provider=grok',
        'POST',
        { redirect_uris: [redirectUri] },
        {},
        201,
      );
      const verifier = randomBytes(48).toString('base64url');
      const query = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        state: 'fixture-state',
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        resource: issuer + '/connectors/mcp',
      });
      const authorization = await fetch(base + '/oauth/authorize?' + query, { redirect: 'manual' });
      expect(authorization.status).toBe(302);
      const consentId = new URL(authorization.headers.get('location')!, base).searchParams.get('request');
      expect(consentId).toBeTruthy();
      const consentPath = '/admin/connectors/consent/' + consentId;
      const { csrf } = await request<{ csrf: string }>(consentPath);
      const consent = await request<{ redirect: string }>(
        consentPath,
        'POST',
        { csrf, scope, approve: true },
        browserHeaders,
      );
      const callback = new URL(consent.redirect);
      expect(callback.origin + callback.pathname).toBe(redirectUri);
      expect(callback.searchParams.get('state')).toBe('fixture-state');
      const exchange = {
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: callback.searchParams.get('code'),
        code_verifier: verifier,
        redirect_uri: redirectUri,
      };
      const access = await request<{ access_token: string }>('/oauth/token', 'POST', exchange, {});
      await request('/oauth/token', 'POST', exchange, {}, 400);
      const connector = { authorization: 'Bearer ' + access.access_token };
      const discover = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
      const catalog = await request<{ result: { tools: unknown[] } }>(
        '/connectors/mcp',
        'POST',
        discover,
        connector,
      );
      expect(catalog.result.tools.length).toBeGreaterThan(0);

      // Reproduce the wrapper register → state stream → claim → result protocol with Portal disabled.
      await request('/admin/agent-messaging/state', 'POST', { enabled: true });
      async function session(username: string) {
        return await request<{
          session_id: string;
          bridge_token: string;
          agent_address: { address: string; binding_generation: number };
        }>(
          '/host/agent-sessions',
          'POST',
          {
            engine: 'codex',
            username,
            cwd: '/fixture',
            invocation_kind: 'interactive',
            upstream_session_id: randomUUID(),
            adapter_protocol: 'fixture-v1',
            adapter_capabilities: { execution_contract_version: 2 },
          },
          hostHeaders(),
        );
      }
      const sender = await session('sender'),
        recipient = await session('recipient');
      const senderApi = '/host/agent-sessions/' + sender.session_id + '/agent-messaging';
      const recipientApi = '/host/agent-sessions/' + recipient.session_id + '/agent-messaging';
      const recipientAuth = { 'x-agent-bridge-token': recipient.bridge_token };
      const body = {
        to: recipient.agent_address.address,
        content: 'Evaluate fixture',
        kind: 'request',
        client_message_id: randomUUID(),
      };
      const send = () =>
        request<{ message: { id: string } }>(senderApi + '/send', 'POST', body, {
          'x-agent-bridge-token': sender.bridge_token,
        });
      const sent = await send();
      expect((await send()).message.id).toBe(sent.message.id);
      // A registered lifecycle by itself cannot claim native work.
      await request(
        recipientApi + '/deliveries/claim',
        'POST',
        { claim_id: randomUUID(), wait_seconds: 0 },
        recipientAuth,
        409,
      );
      const native = randomUUID(),
        stream = randomUUID();
      const nativeControl = '/host/agent-sessions/' + recipient.session_id + '/native-control';
      const instance = { protocol: 1, instance_id: native };
      await request(
        nativeControl,
        'POST',
        instance,
        { 'x-agent-bridge-token': randomBytes(32).toString('base64url') },
        401,
      );
      const binding = await request<{
        request_id: string | null;
        instance_id: string;
        binding_generation: number;
      }>(nativeControl, 'POST', instance, recipientAuth);
      expect(binding).toMatchObject({ request_id: null, instance_id: native });
      await request(
        nativeControl,
        'POST',
        { ...instance, report: { request_id: randomUUID(), status: 'accepted' } },
        recipientAuth,
        503,
      );
      communicator = new WebSocket(base.replace('http:', 'ws:') + '/host/communicator/connect', {
        headers: hostHeaders(),
      });
      const peer = communicator;
      let attached = false;
      peer.on('open', () =>
        peer.send(JSON.stringify({ type: 'hello', protocol: 1, username: 'recipient', version: 'fixture' })),
      );
      peer.on('message', (bytes: Buffer) => {
        const frame = JSON.parse(bytes.toString());
        if (frame.type === 'ready')
          peer.send(
            JSON.stringify({
              type: 'state_open',
              protocol: 1,
              stream_id: stream,
              scope: {
                topic: 'session',
                session_id: recipient.session_id,
                binding_generation: binding.binding_generation,
                native_instance_id: native,
              },
              auth: { bridge_token: recipient.bridge_token },
              payload: { authorization_refresh: 1 },
            }),
          );
        if (frame.stream_id === stream && (frame.type === 'state_snapshot' || frame.type === 'state_delta')) {
          attached = true;
          peer.send(
            JSON.stringify({
              type: 'state_ack',
              protocol: 1,
              stream_id: stream,
              owner_epoch: frame.owner_epoch,
              revision: frame.revision,
            }),
          );
        }
      });
      await vi.waitFor(() => expect(attached, 'native recipient state attachment').toBe(true), 5000);
      const claim = randomUUID();
      const delivery = await request<{ delivery: { message_id: string; work_kind: string } }>(
        recipientApi + '/deliveries/claim',
        'POST',
        { claim_id: claim, wait_seconds: 0 },
        recipientAuth,
      );
      expect(delivery.delivery).toMatchObject({ message_id: sent.message.id, work_kind: 'request' });
      const ack = recipientApi + '/deliveries/' + sent.message.id + '/ack';
      await request(ack, 'POST', { claim_id: claim, outcome: 'accepted' }, recipientAuth);
      const [accepted] = await sql.query<RowDataPacket[]>(
        'SELECT status, completed_at, task_result_status FROM ??.agent_bus_messages WHERE id=?',
        [schema, sent.message.id],
      );
      expect(accepted[0]).toMatchObject({ status: 'accepted', completed_at: null, task_result_status: null });
      const artifact = join(root, 'accepted-work.txt');
      await writeFile(artifact, 'Evaluated once', { flag: 'wx' });
      const checksum = createHash('sha256')
        .update(await readFile(artifact))
        .digest('hex');
      const result = {
        status: 'succeeded',
        summary: 'Fixture evaluated',
        evidence: [{ description: 'Local fixture file', reference: checksum }],
      };
      const complete = { claim_id: claim, outcome: 'completed', task_result: result };
      // Deliver the result to the real owner, then close the downstream socket before replying.
      // The receiver has completed its effect but cannot tell whether the server stored its result.
      let upstreamStatus = 0;
      const lostReply = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const committed = await fetch(base + ack, {
          method: 'POST',
          headers: { ...recipientAuth, 'content-type': 'application/json' },
          body: Buffer.concat(chunks),
        });
        upstreamStatus = committed.status;
        await committed.arrayBuffer();
        res.destroy();
      });
      await new Promise<void>((ready) => lostReply.listen(0, '127.0.0.1', ready));
      try {
        const port = (lostReply.address() as AddressInfo).port;
        await expect(
          fetch('http://127.0.0.1:' + port, { method: 'POST', body: JSON.stringify(complete) }),
        ).rejects.toThrow();
        expect(upstreamStatus).toBe(200);
      } finally {
        await new Promise<void>((done) => lostReply.close(() => done()));
      }
      await request(ack, 'POST', complete, recipientAuth);
      const [results] = await sql.query<RowDataPacket[]>(
        'SELECT status FROM ??.agent_task_results WHERE message_id=?',
        [schema, sent.message.id],
      );
      expect(results).toMatchObject([{ status: 'succeeded' }]);
      expect(results).toHaveLength(1);
      await request(
        ack,
        'POST',
        { ...complete, task_result: { ...result, status: 'failed' } },
        recipientAuth,
        409,
      );
      const next = await request<{ delivery: unknown }>(
        recipientApi + '/deliveries/claim',
        'POST',
        { claim_id: randomUUID(), wait_seconds: 0 },
        recipientAuth,
      );
      expect(next.delivery).toBeNull();

      // A fresh owner must retain the persisted work and enforce subsequent revocation.
      communicator.terminate();
      communicator = undefined;
      ws.terminate();
      ws = undefined;
      await owner!.close();
      owner = undefined;
      await start();
      expect(JSON.parse(await tool('skill_retrieve', { slug })).manifest).toBe(manifest(2));
      expect(JSON.stringify(await request(projectFilePath))).toContain('Wire artifact');
      expect(
        (await request<{ result: { tools: unknown[] } }>('/connectors/mcp', 'POST', discover, connector))
          .result.tools,
      ).toEqual(catalog.result.tools);
      await request('/oauth/revoke', 'POST', { client_id: client.client_id, token: access.access_token }, {});
      await request('/connectors/mcp', 'POST', discover, connector, 401);
      await tool('shared_memory_delete', { slug: memorySlug });
      expect(JSON.parse(await tool('shared_memory_read', { slug: memorySlug })).status).toBe('missing');
      await request('/admin/transfers/' + put.transfer.id, 'DELETE');
      await tool('transfer_get', { id: put.transfer.id }, true);
      await request('/admin/secrets/' + entry.secret.id, 'DELETE');
      await tool('secret_get', { slug: 'wire-secret' }, true);
      await request(projectFilePath, 'DELETE');
      await request(projectFilePath, 'GET', undefined, { cookie }, 404);
      await request('/admin/skills/' + slug, 'DELETE');
      expect(JSON.parse(await tool('skill_retrieve', { slug })).status).toBe('deleted');
      expect(JSON.stringify(events)).not.toContain(secret);
      ws = new WebSocket(base.replace('http:', 'ws:') + '/admin/ws', { headers: { cookie } });
      let ready = false,
        closed = false;
      ws.on('message', (raw: Buffer) => {
        if (JSON.parse(raw.toString()).type === 'hello') ready = true;
      });
      ws.on('close', () => {
        closed = true;
      });
      await vi.waitFor(() => expect(ready).toBe(true));
      await request('/admin/auth/logout', 'POST', {});
      await vi.waitFor(() => expect(closed, 'revoked admin channel').toBe(true));
      await request('/admin/secrets', 'GET', undefined, { cookie }, 401);
    } finally {
      communicator?.terminate();
      ws?.terminate();
      try {
        await owner?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
        resetEnvCache();
      }
    }
  }, 120_000);
});
