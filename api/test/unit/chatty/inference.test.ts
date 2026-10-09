import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChattyInference } from '../../../src/services/chatty/inference.js';
import { DEFAULT_SETTINGS } from '../../../src/services/chatty/contracts.js';

const f = vi.hoisted(() => ({
  release: vi.fn(),
  acquire: vi.fn(),
  usage: vi.fn(),
  flag: vi.fn(),
  canonical: vi.fn(),
  auth: vi.fn(),
  owner: vi.fn(),
}));
vi.mock('../../../src/services/gateway-backends.js', () => ({
  createGatewayBackends: () => ({
    get: () => ({
      models: {
        catalog: async () => [{ id: 'model', display_name: 'Model' }],
        resolve: async (value: string | undefined) => value ?? 'model',
      },
    }),
  }),
}));
vi.mock('../../../src/services/engine-switch.js', () => ({
  readFleetEngineState: async () => ({ codex: true, claude: true, grok: true }),
  assertFleetEngineEnabledForAdmin: async () => {},
}));
vi.mock('../../../src/services/provider-accounts.js', () => ({
  ProviderAccountsService: class {
    usage = f.usage;
    acquire = f.acquire;
    release = f.release;
    heartbeat = async () => {};
  },
}));
vi.mock('../../../src/services/settings.js', () => ({
  SettingsService: class {
    getFlag = f.flag;
    getInt = async () => 90;
  },
}));
vi.mock('../../../src/services/runner-validation.js', () => ({
  createRunnerValidationService: () => ({
    resolveCanonicalPayload: f.canonical,
    canonicalAuthFromPayload: (row: unknown) => (row ? f.auth() : null),
  }),
}));
vi.mock('../../../src/services/grok-auth-owner.js', () => ({
  createGrokAuthOwner: () => ({ ensureFresh: f.owner }),
}));
vi.mock('../../../src/services/runner-client.js', () => ({ createRunnerClient: () => ({}) }));

function setup(responses: Response[]) {
  const candidates = [
    { id: 1, engine: 'codex' },
    { id: 2, engine: 'claude' },
    { id: 3, engine: 'grok' },
  ];
  const db = { select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => candidates }) }) }) };
  const request = vi.fn(async (url: string | URL | Request, _options?: RequestInit) =>
    String(url).endsWith('/capabilities')
      ? Response.json({ protocol: 1, engines: ['codex', 'claude', 'grok'] })
      : responses.shift()!,
  );
  const inference = new ChattyInference(
    {
      db,
      keyring: {},
      env: { AUTH_RUNNER_URL: 'http://runner:8080/verify', AUTH_RUNNER_SHARED_SECRET: 'shared-test' },
    } as never,
    request as typeof fetch,
  );
  return { inference, request };
}
const answer = () => Response.json({ protocol: 1, response: { kind: 'answer', text: 'Hallo', sources: [] } });
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  f.acquire.mockResolvedValue({ account: { id: 1 } });
  f.release.mockResolvedValue(undefined);
  f.usage.mockResolvedValue({});
  f.flag.mockResolvedValue(false);
  f.canonical.mockResolvedValue({ id: 1 });
  f.auth.mockReturnValue({ tokens: { access_token: 'test-only' } });
  f.owner.mockResolvedValue({ auth: { access_token: 'grok-access-only' } });
});
describe('Chatty provider protocol and selection', () => {
  it('falls back automatically, reports the actual engine and releases both leases', async () => {
    const { inference, request } = setup([new Response('', { status: 502 }), answer()]);
    const result = await inference.run('hello', { engine: null, model: null }, DEFAULT_SETTINGS, signal());
    expect(result).toMatchObject({ engine: 'claude', fallback: true });
    expect(f.release).toHaveBeenCalledTimes(2);
    const turns = request.mock.calls.filter(([url]) => String(url).endsWith('/turn'));
    expect(turns.map(([, options]) => JSON.parse(String(options?.body)).engine)).toEqual(['codex', 'claude']);
    expect(turns[0]![1]?.headers).toMatchObject({ 'x-runner-auth': 'shared-test' });
  });
  it('does not silently change a manual engine choice', async () => {
    const { inference, request } = setup([new Response('', { status: 502 }), answer()]);
    await expect(
      inference.run('hello', { engine: 'codex', model: 'model' }, DEFAULT_SETTINGS, signal()),
    ).rejects.toThrow();
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/turn'))).toHaveLength(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('repairs malformed output once within the same account lease', async () => {
    const { inference, request } = setup([
      Response.json({ protocol: 1, response: { kind: 'shell' } }),
      answer(),
    ]);
    expect(
      (await inference.run('hello', { engine: 'codex', model: null }, DEFAULT_SETTINGS, signal())).response
        .kind,
    ).toBe('answer');
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/turn'))).toHaveLength(2);
  });
  it('checks quota again on the actual leased account', async () => {
    f.flag.mockResolvedValue(true);
    f.usage
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValue({ weekly_used_percent: 99 });
    const { inference, request } = setup([answer()]);
    await expect(
      inference.run('hello', { engine: 'codex', model: null }, DEFAULT_SETTINGS, signal()),
    ).rejects.toThrow('quota');
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/turn'))).toHaveLength(0);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('requires a usable canonical payload and never treats a gateway key as upstream access', async () => {
    f.canonical.mockResolvedValue(null);
    const { inference } = setup([]);
    expect((await inference.availability(DEFAULT_SETTINGS)).every((e) => !e.ready)).toBe(true);
    expect(f.acquire).not.toHaveBeenCalled();
  });
  it('uses the Grok refresh owner and sends only its runtime projection', async () => {
    const { inference, request } = setup([answer()]);
    await inference.run('hello', { engine: 'grok', model: null }, DEFAULT_SETTINGS, signal());
    expect(f.owner).toHaveBeenCalledTimes(1);
    const body = request.mock.calls.find(([url]) => String(url).endsWith('/turn'))![1]?.body;
    expect(JSON.parse(String(body)).auth_json).toEqual({ access_token: 'grok-access-only' });
  });
  it('does not advertise a verified but expired access token as ready', async () => {
    const payload = Buffer.from(JSON.stringify({ exp: Date.parse('2020-01-01') / 1000 })).toString(
      'base64url',
    );
    f.auth.mockReturnValue({ tokens: { access_token: `e30.${payload}.signature` } });
    const { inference } = setup([]);
    expect(
      (await inference.availability(DEFAULT_SETTINGS)).find((engine) => engine.engine === 'codex'),
    ).toMatchObject({ ready: false, reason: 'credential_expired' });
  });
});
