import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModelDefaultsService, modelDefaultsCatalog, modelLaunchCatalog } from '../../../src/services/model-defaults.js';
import { applyModelPolicy, buildModelPolicy } from '../../../src/services/model-policy.js';
import { buildModelList, resolveRequestedModel } from '../../../src/services/openai-models.js';
import { createGatewayBackends } from '../../../src/services/gateway-backends.js';
import { LEGACY_MODEL_UPGRADES, normalizeSupportedModel } from '../../../src/services/config-normalizer.js';
import { buildModelTierTable, modelTier } from '../../../src/services/model-tiers.js';
import { registryEntry } from '../../../src/services/model-registry/index.js';
import { createDbFake } from '../../helpers/db-fake.js';

/**
 * GPT-6.1 Luna is registered on an operator report, but its id is NOT verified:
 * the codex-cli 0.165.0 account catalog (fetched 2026-10-29) and binary do not
 * list it. It is therefore live-catalog gated: accepted for explicit authoring,
 * offered by launchpads only where the host's native catalog lists it, and
 * never a latest-only rewrite target, gateway model or Model Class Check entry.
 */
const model = 'gpt-6.1-luna';

describe('unverified GPT-6.1 Luna', () => {
  it('registers as a Tier 1 Luna with GPT-6 Luna capabilities and the live-catalog gate', () => {
    const entry = registryEntry('codex', model)!;
    const luna = registryEntry('codex', 'gpt-6-luna')!;
    expect(entry).toMatchObject({ family: 'luna', tier: 1, status: 'active', defaultEffort: luna.defaultEffort, liveCatalogRequired: true });
    expect(entry.efforts).toEqual(luna.efforts);
    expect(entry.minCliVersion).toBeUndefined();
    expect(luna.status).toBe('active');
    expect(modelTier('codex', model)).toBe(1);
  });

  it('travels only in the additive live_catalog_models list of the signed launch catalog', () => {
    const launch = modelLaunchCatalog('codex', undefined, '0.165.0');
    expect(launch.models.map((entry) => entry.model)).not.toContain(model);
    expect(launch.live_catalog_models).toEqual([
      { model, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], session_efforts: [], default_effort: 'medium' },
    ]);
    expect(launch.default_model).toBe('gpt-6-astra');
    expect(launch.min_cli_versions).toEqual({ 'gpt-6.1-terra': '0.159.0' });
    // The baked golden config (bytes signed by the real producer) carries it too.
    const baked = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../wrappers/testdata/host-codex.json'), 'utf8'));
    expect(baked.engine_options.model_catalog.live_catalog_models.map((entry: { model: string }) => entry.model)).toEqual([model]);
    expect(baked.engine_options.model_catalog.models.map((entry: { model: string }) => entry.model)).not.toContain(model);
  });

  it('is never a latest-only target, so existing Luna selections are not migrated', () => {
    const latest = buildModelPolicy('codex', true);
    expect(applyModelPolicy(latest, 'gpt-6-luna')).toBe('gpt-6-luna');
    expect(applyModelPolicy(latest, 'gpt-5.6-luna')).toBe('gpt-6-luna');
    expect(applyModelPolicy(latest, 'gpt-5.4-mini')).toBe('gpt-6-luna');
    expect(applyModelPolicy(latest, model)).toBe(model);
    expect(latest.latest_models).toContain('gpt-6-luna');
    expect(latest.latest_models).not.toContain(model);
    expect(Object.values(LEGACY_MODEL_UPGRADES)).not.toContain(model);
    // Gated models still follow an admin disable under latest-only.
    expect(modelLaunchCatalog('codex', { ...latest, disabled_models: [model] }).live_catalog_models).toBeUndefined();
    expect(modelLaunchCatalog('codex', latest).live_catalog_models?.map((entry) => entry.model)).toEqual([model]);
  });

  it('stays out of the gateway and the Model Class Check', async () => {
    expect(buildModelList().data.map((entry) => entry.id)).not.toContain(model);
    expect(() => resolveRequestedModel(model)).toThrow(/Unsupported model/);
    const backend = createGatewayBackends({ db: createDbFake() as never, env: {} as never, keyring: {} as never }).get('codex');
    expect((await backend.models.catalog()).map((entry) => entry.id)).not.toContain(model);
    const table = buildModelTierTable(['codex'], { codex: buildModelPolicy('codex').latest_models });
    expect(table.flatMap((row) => row.models.map((entry) => entry.model))).not.toContain(model);
    expect(table.find((row) => row.tier === 1)?.models.map((entry) => entry.model)).toEqual(['gpt-6-luna']);
  });

  it('remains accepted for explicit authoring, flagged for the admin picker', async () => {
    expect(normalizeSupportedModel(model)).toBe(model);
    expect(modelDefaultsCatalog('codex').find((entry) => entry.model === model)).toEqual({
      model, persistent_efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium', live_catalog_required: true,
    });
    const db = createDbFake();
    const defaults = new ModelDefaultsService(db as never);
    expect(await defaults.get('codex')).toMatchObject({ model: 'gpt-6-astra', reasoning_effort: 'low' });
    expect(db.inserts).toHaveLength(0);
    expect(await defaults.set('codex', { model })).toMatchObject({ model, reasoning_effort: 'medium' });
  });
});
