import { describe, it, expect } from 'vitest';
import { buildModelPolicy, applyModelPolicy, readModelPolicy } from '../../../src/services/model-policy.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { versions, clientConfigDocuments } from '../../../src/db/schema.js';
import { ModelDefaultsService, modelLaunchCatalog } from '../../../src/services/model-defaults.js';
import { createGatewayBackends } from '../../../src/services/gateway-backends.js';
import type { Engine } from '../../../src/util/engine.js';

function database(engine: Engine, disabled = '') {
  return createDbFake(new Map([[versions, [
    { name: `${engine}_models_latest_only`, version: '1' },
    { name: `${engine}_models_disabled`, version: disabled },
  ]]]));
}
describe('current model policy', () => {
  it('keeps the newest numeric version of every family, including single-generation families and Grok Fast', () => {
    expect(buildModelPolicy('codex', true).latest_models).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra']);
    expect(buildModelPolicy('claude', true).latest_models).toEqual(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(buildModelPolicy('grok', true).latest_models).toEqual(['grok-4.7', 'grok-4.7-build-fast']);
  });
  it('carries existing retired model aliases through to the newest family member', () => {
    expect(applyModelPolicy(buildModelPolicy('codex', true), 'gpt-5.4-mini')).toBe('gpt-6-luna');
    expect(applyModelPolicy(buildModelPolicy('claude', true), 'claude-3-haiku-20240307')).toBe('claude-haiku-5-5');
  });
  it('is off by default and rejects unknown and prototype-shaped IDs when enabled', async () => {
    expect((await readModelPolicy(createDbFake() as never, 'codex')).latest_only).toBe(false);
    expect(applyModelPolicy(buildModelPolicy('codex'), 'custom')).toBe('custom');
    for (const model of ['unknown', 'constructor', '__proto__']) expect(() => applyModelPolicy(buildModelPolicy('codex', true), model)).toThrow();
  });
  for (const [engine, old, next] of [
    ['codex', 'gpt-5.6-sol', 'gpt-6.1-sol'],
    ['claude', 'claude-opus-4-5-20251101', 'claude-opus-5-5'],
    ['grok', 'grok-4.5', 'grok-4.7'],
  ] as const) {
    it(`${engine}: gateways, signed menus and defaults use the same successors without rewriting stored selections`, async () => {
      const db = database(engine);
      db.tables.set(clientConfigDocuments, [{ id: 1, engine, sha256: 'a'.repeat(64), body: '', settings: { model: old }, updatedAt: '2026-10-16T00:00:00Z' }]);
      const policy = await readModelPolicy(db as never, engine);
      expect(applyModelPolicy(policy, old)).toBe(next);
      expect(modelLaunchCatalog(engine, policy).models.map(entry => entry.model).sort()).toEqual([...policy.latest_models].sort());
      const response = await new ModelDefaultsService(db as never).get(engine);
      expect(response.model).toBe(next);
      expect(response.catalog.map(entry => entry.model)).toEqual(policy.latest_models);
      expect(db.tables.get(clientConfigDocuments)?.[0]?.settings).toEqual({ model: old });
      const backend = createGatewayBackends({ db: db as never, env: {} as never, keyring: {} as never }).get(engine);
      expect(await backend.models.resolve(old)).toBe(next);
      expect((await backend.models.catalog()).map(entry => entry.id)).toEqual(policy.latest_models);
      await expect(backend.models.resolve('unknown')).rejects.toMatchObject({ code: 'model_not_found' });
    });
  }
  it('does not revive a manually disabled successor or fall back to an older generation', async () => {
    const db = database('grok', 'grok-4.7');
    const backend = createGatewayBackends({ db: db as never, env: {} as never, keyring: {} as never }).get('grok');
    await expect(backend.models.resolve('grok-4.5')).rejects.toMatchObject({ code: 'model_disabled' });
    expect((await backend.models.catalog()).map(entry => entry.id)).toEqual(['grok-4.7-build-fast']);
  });
});
