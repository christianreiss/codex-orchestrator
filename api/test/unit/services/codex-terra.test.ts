import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { ModelDefaultsService, modelDefaultsCatalog, modelLaunchCatalog } from '../../../src/services/model-defaults.js';
import { buildModelPolicy, applyModelPolicy } from '../../../src/services/model-policy.js';
import { buildModelList, resolveRequestedModel } from '../../../src/services/openai-models.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { createGatewayBackends } from '../../../src/services/gateway-backends.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';

const model = 'gpt-6.1-terra';
// Native 0.164.0 account catalog, fetched 2026-10-26T18:39:04Z. API defaults differ.
const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

describe('public Codex GPT-6.1 Terra', () => {
  it('offers native metadata through defaults, gateway and signed menus without changing fleet defaults', async () => {
    expect(modelDefaultsCatalog('codex').find(entry => entry.model === model))
      .toEqual({ model, persistent_efforts: efforts, default_effort: 'low' });
    expect(modelLaunchCatalog('codex').models.find(entry => entry.model === model))
      .toEqual({ model, efforts, session_efforts: [], default_effort: 'low' });
    expect(modelLaunchCatalog('codex').default_model).toBe('gpt-6-astra');
    expect(resolveRequestedModel(model)).toBe(model);
    expect(buildModelList().data.map(entry => entry.id)).toContain(model);
    const db = createDbFake();
    expect(await new ModelDefaultsService(db as never).get('codex')).toMatchObject({ model: 'gpt-6-astra', reasoning_effort: 'medium' });
    expect(db.inserts).toHaveLength(0);
    const backend = createGatewayBackends({ db: db as never, env: {} as never, keyring: {} as never }).get('codex');
    expect(await backend.models.resolve(model)).toBe(model);
    expect((await backend.models.catalog()).map(entry => entry.id)).toContain(model);
  });

  it('keeps the older Terra available unless the operator enables latest-family policy', () => {
    expect(applyModelPolicy(buildModelPolicy('codex'), 'gpt-5.6-terra')).toBe('gpt-5.6-terra');
    const latest = buildModelPolicy('codex', true);
    expect(applyModelPolicy(latest, 'gpt-5.6-terra')).toBe(model);
    expect(latest.latest_models).toContain(model);
    expect(latest.latest_models).not.toContain('gpt-5.6-terra');
    expect(modelLaunchCatalog('codex', latest).models.find(entry => entry.model === model)?.default_effort).toBe('low');
  });

  it.each(efforts)('roundtrips native %s effort across root, profiles and host overrides', async effort => {
    const configs = new ClientConfigService(createDbFake() as never);
    const saved = await configs.store({ settings: { model, model_reasoning_effort: effort,
      native_settings: { review_model: model, agents: { default_subagent_model: model, default_subagent_reasoning_effort: effort } },
      profiles: [{ name: 'terra', model, model_reasoning_effort: effort }] } });
    expect((await configs.adminFetch('codex')).settings).toEqual(saved.settings);
    expect(saved.content).toContain(`model = "${model}"`);
    expect(saved.content).toContain(`model_reasoning_effort = "${effort}"`);
    const profile = configs.render(saved.settings).profiles![0]!.content;
    expect(profile).toContain(`model = "${model}"`);
    expect(profile).toContain(`model_reasoning_effort = "${effort}"`);
    const host = renderTomlForHost({ settings: { model: 'gpt-6-astra' }, host: { modelOverride: model, reasoningEffortOverride: effort, clientVersion: '0.164.0' } as never, baseUrl: null, apiKey: null });
    expect(host.content).toContain(`model = "${model}"`);
    expect(host.content).toContain(`model_reasoning_effort = "${effort}"`);
    expect(normalizeCodexNativeSettings({ agents: { default_subagent_model: model, default_subagent_reasoning_effort: effort } }))
      .toEqual({ agents: { default_subagent_model: model, default_subagent_reasoning_effort: effort } });
  });

  it('persists the native low default and rejects API-only none', async () => {
    const db = createDbFake(), defaults = new ModelDefaultsService(db as never);
    expect(await defaults.set('codex', { model })).toMatchObject({ model, reasoning_effort: 'low' });
    expect(db.tables.get(clientConfigDocuments)?.at(-1)?.body).toContain('model_reasoning_effort = "low"');
    await expect(defaults.set('codex', { model, reasoning_effort: 'none' })).rejects.toMatchObject({ status: 422 });
    expect(await defaults.set('codex', { model, reasoning_effort: 'ultra' })).toMatchObject({ model, reasoning_effort: 'ultra' });
  });

  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('loads rendered root/profile settings with native 0.164 without inference', () => {
    const rendered = new ClientConfigService({} as never).render({ model, model_reasoning_effort: 'ultra', profiles: [{ name: 'terra', model, model_reasoning_effort: 'low' }] });
    for (const content of [rendered.content, rendered.profiles![0]!.content]) {
      const home = mkdtempSync(join(tmpdir(), 'terra-config-'));
      try {
        writeFileSync(join(home, 'config.toml'), content);
        const result = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 15000 });
        expect(result.status, result.stderr).toBe(0);
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
  });
});
