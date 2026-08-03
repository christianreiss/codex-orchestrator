import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { describe, it, expect, beforeEach } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerAdminHostsRoutes } from '../../../src/routes/admin/hosts/index.js';
import { UnauthorizedError } from '../../../src/http/errors.js';
import type { HostManagementService } from '../../../src/services/host-management.js';
import type { InsecureWindowAdminService } from '../../../src/services/insecure-window-admin.js';
import type { Host } from '../../../src/db/schema.js';
import type { RouteContext } from '../../../src/routes/index.js';

function fakeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: 42,
    fqdn: 'vm.example.com',
    apiKey: 'a'.repeat(64),
    apiKeyHash: 'a'.repeat(64),
    apiKeyEnc: null,
    status: 'active',
    secure: 0,
    allowRoamingIps: 0,
    reverseDnsMode: null,
    lastRefresh: null,
    authDigest: null,
    ip4: null,
    ip6: null,
    clientVersion: null,
    clientVersionOverride: null,
    wrapperVersion: null,
    agentsDocumentIdOverride: null,
    apiCalls: 0,
    insecureEnabledUntil: null,
    insecureGraceUntil: null,
    insecureWindowMinutes: null,
    curlInsecure: 0,
    browserosMcpEnabled: 0,
    expiresAt: null,
    vip: 0,
    lanePreference: null,
    modelOverride: null,
    reasoningEffortOverride: null,
    autoUpdateOverride: null,
    lastCronCheck: null,
    scalingExempt: 0,
    engines: 'codex',
    claudeClientVersion: null,
    claudeClientVersionOverride: null,
    claudeWrapperVersion: null,
    claudeAuthDigest: null,
    claudeModelOverride: null,
    claudeReasoningEffortOverride: null,
    claudeLastRefresh: null,
    configVersion: 0,
    wrapperTrack: 'v2',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  } as Host;
}

interface ServiceCall {
  method: string;
  args: unknown[];
}

function makeMocks() {
  const calls: ServiceCall[] = [];
  const installer = {
    token: 'tok-deadbeef',
    mode: 'codex' as const,
    label: 'Codex',
    url: 'https://orch.example.com/install/tok-deadbeef',
    command: 'curl -fsSL https://orch.example.com/install/tok-deadbeef | sh',
    expires_at: '2024-01-01T01:00:00Z',
  };
  const hostService = {
    register: async (req: unknown) => {
      calls.push({ method: 'register', args: [req] });
      return {
        host: fakeHost({ fqdn: (req as { fqdn: string }).fqdn }),
        apiKeyPlain: 'sk-codex-aaaaa',
        installer,
      };
    },
    quickRegister: async (req: unknown) => {
      calls.push({ method: 'quickRegister', args: [req] });
      return {
        host: fakeHost({ fqdn: 'tmp-x' }),
        apiKeyPlain: 'sk-codex-bbbbb',
        installer,
      };
    },
    mintInstaller: async (id: number, additionalEngines?: string[], options?: { curlInsecure?: boolean }) => {
      calls.push({ method: 'mintInstaller', args: [id, additionalEngines, options] });
      return {
        host: fakeHost({ id }),
        installer,
      };
    },
    requireById: async (id: number) => {
      calls.push({ method: 'requireById', args: [id] });
      return fakeHost({ id });
    },
    delete: async (id: number) => {
      calls.push({ method: 'delete', args: [id] });
      return { host: fakeHost({ id }) };
    },
    clear: async (id: number) => {
      calls.push({ method: 'clear', args: [id] });
      return { host: fakeHost({ id }) };
    },
    releaseIpBinding: async (id: number) => {
      calls.push({ method: 'releaseIpBinding', args: [id] });
      return fakeHost({ id, ip4: null, ip6: null });
    },
    setRoaming: async (id: number, allow: boolean) => {
      calls.push({ method: 'setRoaming', args: [id, allow] });
      return fakeHost({ id, allowRoamingIps: allow ? 1 : 0 });
    },
    setSecure: async (id: number, secure: boolean, gm: number | null) => {
      calls.push({ method: 'setSecure', args: [id, secure, gm] });
      return fakeHost({ id, secure: secure ? 1 : 0 });
    },
    setVip: async (id: number, vip: boolean) => {
      calls.push({ method: 'setVip', args: [id, vip] });
      return fakeHost({ id, vip: vip ? 1 : 0 });
    },
    setScalingExempt: async (id: number, exempt: boolean) => {
      calls.push({ method: 'setScalingExempt', args: [id, exempt] });
      return fakeHost({ id, scalingExempt: exempt ? 1 : 0 });
    },
    setAutoUpdateOverride: async (id: number, override: boolean | null) => {
      calls.push({ method: 'setAutoUpdateOverride', args: [id, override] });
      return fakeHost({
        id,
        autoUpdateOverride: override === null ? null : override ? 1 : 0,
      });
    },
    setCurlInsecure: async (id: number, allow: boolean) => {
      calls.push({ method: 'setCurlInsecure', args: [id, allow] });
      return fakeHost({ id, curlInsecure: allow ? 1 : 0 });
    },
    setBrowserOsMcp: async (id: number, enabled: boolean) => {
      calls.push({ method: 'setBrowserOsMcp', args: [id, enabled] });
      return fakeHost({ id, browserosMcpEnabled: enabled ? 1 : 0 });
    },
    setEngines: async (id: number, engines: string[]) => {
      calls.push({ method: 'setEngines', args: [id, engines] });
      return fakeHost({ id, engines: engines.join(',') });
    },
    setReverseDnsMode: async (id: number, mode: string) => {
      calls.push({ method: 'setReverseDnsMode', args: [id, mode] });
      return fakeHost({
        id,
        reverseDnsMode: mode === 'enabled' ? 1 : mode === 'disabled' ? 0 : null,
      });
    },
    setModelOverrides: async (id: number, payload: unknown) => {
      calls.push({ method: 'setModelOverrides', args: [id, payload] });
      return fakeHost({ id });
    },
    setCodexVersionOverride: async (id: number, sel: string | null) => {
      calls.push({ method: 'setCodexVersionOverride', args: [id, sel] });
      return fakeHost({ id, clientVersionOverride: sel });
    },
    setClaudeVersionOverride: async (id: number, sel: string | null) => {
      calls.push({ method: 'setClaudeVersionOverride', args: [id, sel] });
      return fakeHost({ id, claudeClientVersionOverride: sel });
    },
    setAgentsDocumentOverride: async (id: number, sel: string | number | null) => {
      calls.push({ method: 'setAgentsDocumentOverride', args: [id, sel] });
      return fakeHost({
        id,
        agentsDocumentIdOverride: typeof sel === 'number' ? sel : null,
      });
    },
  } as unknown as HostManagementService;

  const insecure = {
    enable: async (id: number, minutes: number | null) => {
      calls.push({ method: 'insecure.enable', args: [id, minutes] });
      return fakeHost({ id, secure: 0 });
    },
    disable: async (id: number) => {
      calls.push({ method: 'insecure.disable', args: [id] });
      return fakeHost({ id });
    },
    listPending: async () => {
      calls.push({ method: 'insecure.listPending', args: [] });
      return [
        {
          id: 1,
          host_id: 42,
          fqdn: 'vm.example.com',
          request_ip: '1.2.3.4',
          requested_at: '2024-01-01T00:00:00Z',
          resolved_at: null,
          updated_at: '2024-01-01T00:00:00Z',
          status: 'pending',
        },
      ];
    },
    approve: async (id: number, minutes: number | null) => {
      calls.push({ method: 'insecure.approve', args: [id, minutes] });
      return {
        requestId: id,
        host: fakeHost(),
        enabledUntil: '2024-01-01T01:00:00Z',
        graceUntil: '2024-01-01T02:00:00Z',
        windowMinutes: 60,
      };
    },
    deny: async (id: number) => {
      calls.push({ method: 'insecure.deny', args: [id] });
      return { requestId: id, host: fakeHost() };
    },
    allowDomain: async (id: number, domain: string | null, minutes: number | null) => {
      calls.push({ method: 'insecure.allowDomain', args: [id, domain, minutes] });
      return {
        requestId: id,
        host: fakeHost(),
        domain: {
          id: 7,
          domain: 'example.com',
          window_minutes: 30,
          enabled_until: '2024-01-01T00:30:00Z',
          revoked_at: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        enabledUntil: '2024-01-01T00:30:00Z',
        graceUntil: null,
        windowMinutes: 30,
      };
    },
    revokeDomain: async (id: number) => {
      calls.push({ method: 'insecure.revokeDomain', args: [id] });
      return {
        id,
        domain: 'example.com',
        window_minutes: 30,
        enabled_until: null,
        revoked_at: '2024-01-01T00:30:00Z',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };
    },
  } as unknown as InsecureWindowAdminService;

  return { calls, hostService, insecure };
}

interface BuildOptions {
  authenticated?: boolean;
  hostService?: HostManagementService;
  insecure?: InsecureWindowAdminService;
}

async function build(options: BuildOptions): Promise<{ app: FastifyInstance; calls: ServiceCall[] }> {
  const mocks = makeMocks();
  const hostService = options.hostService ?? mocks.hostService;
  const insecure = options.insecure ?? mocks.insecure;
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);

  app.decorate('requireAdmin', async function requireAdmin(req: FastifyRequest) {
    if (options.authenticated) {
      req.admin = {
        user: { id: 1, accessLevel: 'owner' } as never,
        session: { id: 1 } as never,
      };
      return;
    }
    throw new UnauthorizedError('Admin session required', 'admin_required');
  });
  // We need a fake env on the ctx for register
  const ctx: RouteContext = {
    db: {} as never,
    env: { DEFAULT_HOST_ENGINES: 'codex' } as never,
    keyring: {} as never,
  };
  const authView = async () => ({
    canonical_last_refresh: null,
    canonical_digest: null,
    recent_digests: [],
    auth: null,
  });
  await registerAdminHostsRoutes(app, ctx, { hostService, insecure, authView });
  return { app, calls: mocks.calls };
}

describe('admin hosts routes', () => {
  describe('auth gating', () => {
    it('returns 401 when no admin session is present', async () => {
      const { app } = await build({ authenticated: false });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/register',
        payload: { fqdn: 'x.example.com' },
      });
      expect(r.statusCode).toBe(401);
      const body = JSON.parse(r.payload);
      expect(body.status).toBe('error');
      expect(body.code).toBe('admin_required');
      await app.close();
    });
  });

  describe('POST /admin/hosts/register', () => {
    it('rejects when fqdn is missing', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({ method: 'POST', url: '/admin/hosts/register', payload: {} });
      expect(r.statusCode).toBe(422);
      expect(JSON.parse(r.payload).code).toBe('validation_failed');
      await app.close();
    });

    it('hands the request through to the service and returns the installer', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/register',
        payload: { fqdn: 'vm.example.com', secure: false, engines: 'codex,claude' },
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body.status).toBe('ok');
      expect(body.host).toMatchObject({
        id: 42,
        fqdn: 'vm.example.com',
        api_key: 'sk-codex-aaaaa',
      });
      expect(body.installer.token).toBe('tok-deadbeef');
      expect(calls.find((c) => c.method === 'register')).toBeTruthy();
      await app.close();
    });

    it('rejects invalid reverse_dns_mode', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/register',
        payload: { fqdn: 'vm.example.com', reverse_dns_mode: 'maybe' },
      });
      expect(r.statusCode).toBe(422);
      expect(JSON.parse(r.payload).message).toMatch(/reverse_dns_mode/);
      await app.close();
    });
  });

  describe('POST /admin/hosts/quick-register', () => {
    it('returns installer for the auto-generated FQDN', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/quick-register',
        payload: { engines: 'claude' },
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body.host.fqdn).toBe('tmp-x');
      expect(calls.find((c) => c.method === 'quickRegister')).toBeTruthy();
      await app.close();
    });
  });

  describe('GET /admin/hosts/:id/auth', () => {
    it('returns the host shell', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({ method: 'GET', url: '/admin/hosts/42/auth' });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body.host.id).toBe(42);
      expect(body.engine).toBe('codex');
      await app.close();
    });

    it('rejects non-numeric ids', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({ method: 'GET', url: '/admin/hosts/abc/auth' });
      // matched route, fails the parseId helper
      expect(r.statusCode).toBe(422);
      await app.close();
    });
  });

  describe('POST /admin/hosts/:id/installer', () => {
    it('returns a fresh installer for the existing host', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({ method: 'POST', url: '/admin/hosts/42/installer' });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body.installer.command).toContain('/install/tok-deadbeef');
      const args = calls.find((c) => c.method === 'mintInstaller')?.args;
      expect(args?.[0]).toBe(42);
      expect(args?.[1]).toBeUndefined();
      expect(args?.[2]).toEqual({ curlInsecure: undefined });
      await app.close();
    });

    it('forwards requested engines when the body specifies them', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/installer',
        payload: { engines: ['claude'] },
      });
      expect(r.statusCode).toBe(200);
      const args = calls.find((c) => c.method === 'mintInstaller')?.args;
      expect(args?.[0]).toBe(42);
      expect(args?.[1]).toEqual(['claude']);
      expect(args?.[2]).toEqual({ curlInsecure: undefined });
      await app.close();
    });

    it('forwards the current curl-insecure value with installer mints', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/installer',
        payload: { curl_insecure: true },
      });
      expect(r.statusCode).toBe(200);
      const args = calls.find((c) => c.method === 'mintInstaller')?.args;
      expect(args?.[0]).toBe(42);
      expect(args?.[1]).toBeUndefined();
      expect(args?.[2]).toEqual({ curlInsecure: true });
      await app.close();
    });

    it('accepts a comma-separated engines string and normalises it', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/installer',
        payload: { engines: 'codex,claude' },
      });
      expect(r.statusCode).toBe(200);
      const args = calls.find((c) => c.method === 'mintInstaller')?.args;
      expect(args?.[1]).toEqual(['codex', 'claude']);
      expect(args?.[2]).toEqual({ curlInsecure: undefined });
      await app.close();
    });

    it('ignores unrecognised engine names', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/installer',
        payload: { engines: ['mystery'] },
      });
      expect(r.statusCode).toBe(200);
      const args = calls.find((c) => c.method === 'mintInstaller')?.args;
      // empty array filters down → service receives undefined
      expect(args?.[1]).toBeUndefined();
      expect(args?.[2]).toEqual({ curlInsecure: undefined });
      await app.close();
    });

    it('rejects a non-numeric host id', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({ method: 'POST', url: '/admin/hosts/nope/installer' });
      expect(r.statusCode).toBe(422);
      await app.close();
    });
  });

  describe('POST /admin/hosts/:id/engines', () => {
    it('persists a normalized non-empty engine list', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/engines',
        payload: { engines: 'claude,codex,claude' },
      });
      expect(r.statusCode).toBe(200);
      const args = calls.find((c) => c.method === 'setEngines')?.args;
      expect(args).toEqual([42, ['claude', 'codex']]);
      await app.close();
    });

    it('rejects a request that would leave the host with no engines', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/engines',
        payload: { engines: [] },
      });
      expect(r.statusCode).toBe(422);
      expect(JSON.parse(r.payload).code).toBe('validation_failed');
      await app.close();
    });
  });

  describe('DELETE /admin/hosts/:id', () => {
    it('responds with deleted id', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({ method: 'DELETE', url: '/admin/hosts/42' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.payload).deleted).toBe(42);
      expect(calls.find((c) => c.method === 'delete')).toBeTruthy();
      await app.close();
    });
  });

  describe('POST /admin/hosts/:id/release-ip-binding', () => {
    it('releases both static IP bindings without requiring a request body', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({ method: 'POST', url: '/admin/hosts/42/release-ip-binding' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.payload).host.id).toBe(42);
      expect(calls.find((c) => c.method === 'releaseIpBinding')?.args).toEqual([42]);
      await app.close();
    });

    it('rejects a non-numeric host id', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({ method: 'POST', url: '/admin/hosts/not-a-host/release-ip-binding' });
      expect(r.statusCode).toBe(422);
      await app.close();
    });
  });

  describe('POST /admin/hosts/:id/secure', () => {
    it('accepts the secure toggle + optional grace_minutes', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/secure',
        payload: { secure: true, grace_minutes: 15 },
      });
      expect(r.statusCode).toBe(200);
      const setSecureCall = calls.find((c) => c.method === 'setSecure');
      expect(setSecureCall?.args).toEqual([42, true, 15]);
      await app.close();
    });

    it('rejects bad secure payload', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/secure',
        payload: {},
      });
      expect(r.statusCode).toBe(422);
      await app.close();
    });
  });

  describe('POST /admin/hosts/:id/auto-update (tri-state)', () => {
    it.each([
      [{ override: true }, true],
      [{ override: false }, false],
      [{ override: null }, null],
      [{}, null],
    ])('maps payload %j -> %s', async (payload, expected) => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/auto-update',
        payload,
      });
      expect(r.statusCode).toBe(200);
      const call = calls.find((c) => c.method === 'setAutoUpdateOverride');
      expect(call?.args).toEqual([42, expected]);
      await app.close();
    });
  });

  describe('POST /admin/hosts/:id/insecure/{enable,disable}', () => {
    it('enable accepts duration_minutes within range', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/insecure/enable',
        payload: { duration_minutes: 45 },
      });
      expect(r.statusCode).toBe(200);
      const call = calls.find((c) => c.method === 'insecure.enable');
      expect(call?.args).toEqual([42, 45]);
      await app.close();
    });

    it('enable rejects out-of-range duration_minutes', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/insecure/enable',
        payload: { duration_minutes: 9999 },
      });
      expect(r.statusCode).toBe(422);
      await app.close();
    });

    it('disable does not require a body', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({ method: 'POST', url: '/admin/hosts/42/insecure/disable' });
      expect(r.statusCode).toBe(200);
      expect(calls.find((c) => c.method === 'insecure.disable')).toBeTruthy();
      await app.close();
    });
  });

  describe('POST /admin/hosts/:id/browseros-mcp', () => {
    it('toggles BrowserOS MCP for a host', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/browseros-mcp',
        payload: { browseros_mcp: true },
      });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.payload).host.browseros_mcp_enabled).toBe(true);
      expect(calls.find((c) => c.method === 'setBrowserOsMcp')?.args).toEqual([42, true]);
      await app.close();
    });
  });

  describe('insecure approval flow', () => {
    it('GET /admin/insecure-approvals/pending', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({ method: 'GET', url: '/admin/insecure-approvals/pending' });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body.requests).toHaveLength(1);
      expect(body.requests[0].host_id).toBe(42);
      await app.close();
    });

    it('POST /admin/insecure-approvals/:id/approve', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/insecure-approvals/7/approve',
        payload: { duration_minutes: 30 },
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body.request).toEqual({ id: 7, status: 'approved' });
      expect(calls.find((c) => c.method === 'insecure.approve')?.args).toEqual([7, 30]);
      await app.close();
    });

    it('POST /admin/insecure-approvals/:id/deny', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({ method: 'POST', url: '/admin/insecure-approvals/9/deny' });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body.request).toEqual({ id: 9, status: 'denied' });
      expect(calls.find((c) => c.method === 'insecure.deny')?.args).toEqual([9]);
      await app.close();
    });

    it('POST /admin/insecure-approvals/:id/allow-domain', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/insecure-approvals/3/allow-domain',
        payload: { domain: 'example.com' },
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body.request).toEqual({ id: 3, status: 'approved' });
      expect(body.domain).toMatchObject({ domain: 'example.com' });
      expect(calls.find((c) => c.method === 'insecure.allowDomain')?.args).toEqual([3, 'example.com', null]);
      await app.close();
    });

    it('POST /admin/insecure-domain-allows/:id/revoke', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/insecure-domain-allows/2/revoke',
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body.domain).toMatchObject({ id: 2, domain: 'example.com' });
      expect(calls.find((c) => c.method === 'insecure.revokeDomain')?.args).toEqual([2]);
      await app.close();
    });
  });

  describe('POST /admin/hosts/:id/reverse-dns', () => {
    it.each([
      ['global', null],
      ['enabled', 'enabled'],
      ['disabled', 'disabled'],
    ])('accepts mode=%s -> service mode=%s', async (mode, _expected) => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/reverse-dns',
        payload: { mode },
      });
      expect(r.statusCode).toBe(200);
      const call = calls.find((c) => c.method === 'setReverseDnsMode');
      expect(call?.args[0]).toBe(42);
      expect(call?.args[1]).toBe(mode);
      await app.close();
    });

    it('rejects unknown mode', async () => {
      const { app } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/reverse-dns',
        payload: { mode: 'sometimes' },
      });
      expect(r.statusCode).toBe(422);
      await app.close();
    });
  });

  describe('POST /admin/hosts/:id/model', () => {
    it('passes Codex model overrides through with canonical field names', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/model',
        payload: { model_override: 'gpt-5.6-terra', reasoning_effort_override: 'ultra' },
      });
      expect(r.statusCode).toBe(200);
      const call = calls.find((c) => c.method === 'setModelOverrides');
      expect(call?.args).toEqual([
        42,
        {
          model_override: 'gpt-5.6-terra',
          reasoning_effort_override: 'ultra',
          claude_model_override: undefined,
          includeClaudeOverride: false,
        },
      ]);
      await app.close();
    });
  });

  describe('version override routes', () => {
    it('codex-version accepts a semver', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/codex-version',
        payload: { selection: '0.125.0' },
      });
      expect(r.statusCode).toBe(200);
      const call = calls.find((c) => c.method === 'setCodexVersionOverride');
      expect(call?.args).toEqual([42, '0.125.0']);
      await app.close();
    });

    it('codex-version global clears override', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/codex-version',
        payload: { selection: 'global' },
      });
      expect(r.statusCode).toBe(200);
      const call = calls.find((c) => c.method === 'setCodexVersionOverride');
      expect(call?.args).toEqual([42, null]);
      await app.close();
    });

    it('claude-version accepts numeric body shape (legacy alias)', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/claude-version',
        payload: { claude_client_version_override: '1.2.3' },
      });
      expect(r.statusCode).toBe(200);
      const call = calls.find((c) => c.method === 'setClaudeVersionOverride');
      expect(call?.args).toEqual([42, '1.2.3']);
      await app.close();
    });

    it('agents-version accepts an id and "global"', async () => {
      const { app, calls } = await build({ authenticated: true });
      const r1 = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/agents-version',
        payload: { selection: '17' },
      });
      expect(r1.statusCode).toBe(200);
      const r2 = await app.inject({
        method: 'POST',
        url: '/admin/hosts/42/agents-version',
        payload: { selection: 'global' },
      });
      expect(r2.statusCode).toBe(200);
      const ids = calls.filter((c) => c.method === 'setAgentsDocumentOverride').map((c) => c.args[1]);
      expect(ids).toEqual(['17', null]);
      await app.close();
    });
  });
});
