import { beforeEach, describe, expect, it, vi } from 'vitest';
import { versions } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { capabilitiesFor } from '../../../src/services/transport-capabilities.js';

const mock = vi.hoisted(() => ({ fresh: vi.fn(), owner: vi.fn(), verified: vi.fn() }));
vi.mock('../../../src/services/kimi-auth-owner.js', () => ({ createKimiAuthOwner: mock.owner }));
vi.mock('../../../src/services/auth-traffic-verification.js', () => ({
  createAuthTrafficVerifier: (deps: { snapshotProvider: () => Promise<{ auth: unknown }> }) => ({
    getAuthSnapshot: async () => (await deps.snapshotProvider()).auth,
    recordExecSuccess: mock.verified,
  }),
}));
import { createGatewayBackends } from '../../../src/services/gateway-backends.js';

describe('Kimi gateway backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.owner.mockReturnValue({ ensureFresh: mock.fresh });
  });

  it('shares one auth owner, supplies real runner expiry and keeps refresh material absent', async () => {
    const native = { access_token: 'access-only', refresh_token: '', expires_at: 0, expires_in: 0 };
    mock.fresh.mockResolvedValue({ row: { id: 7 }, auth: { kimi_code: native }, expires_at: '2030-01-01T00:00:00Z' });
    const backends = createGatewayBackends({ db: {} as never, keyring: {} as never, env: { AUTH_RUNNER_EXEC_TIMEOUT: 120 } as never });
    const backend = backends.get('kimi');
    expect(backends.get('kimi')).toBe(backend);
    const auth = await backend.authSnapshot();
    expect(auth).toEqual({ kimi_code: { ...native, expires_at: Date.parse('2030-01-01T00:00:00Z') / 1000 } });
    await backend.authSnapshot();
    expect(mock.owner).toHaveBeenCalledTimes(1);
    expect(mock.fresh).toHaveBeenCalledWith({ minValiditySeconds: 420 });
    expect(native.expires_at).toBe(0);
    backend.onExecSuccess(auth);
    expect(mock.verified).toHaveBeenCalledWith(auth);
  });

  it('uses the Kimi catalog and settings instead of falling through to Codex', async () => {
    const db = createDbFake(new Map([[versions, [
      { name: 'kimi_default_model', version: 'k3-256k' },
      { name: 'kimi_models_disabled', version: 'k3' },
    ]]]));
    const models = createGatewayBackends({ db: db as never, keyring: {} as never, env: {} as never }).get('kimi').models;
    expect(await models.resolve(undefined)).toBe('k3-256k');
    expect(await models.resolve('kimi-for-coding')).toBe('kimi-for-coding');
    await expect(models.resolve('k3')).rejects.toMatchObject({ status: 403, code: 'model_disabled' });
    await expect(models.resolve('gpt-test')).rejects.toMatchObject({ status: 404, code: 'model_not_found' });
    const catalog = await models.catalog();
    expect(catalog).not.toContainEqual(expect.objectContaining({ id: 'k3' }));
    expect(catalog).toContainEqual(expect.objectContaining({ id: 'k3-256k', owned_by: 'moonshotai', max_input_tokens: 262144 }));
  });

  it('advertises neither exact usage nor stop reasons', () => {
    expect(capabilitiesFor('runner-cli', 'kimi')).toMatchObject({
      reportsExactUsage: false, reportsStopReason: false,
      controls: { model: 'enforced', system: 'enforced', stream: 'unsupported', tools: 'unsupported', max_tokens: 'unsupported' },
    });
  });
});
