import { describe, expect, it } from 'vitest';
import { assertCodexModelVersion } from '../../../src/services/codex-model-support.js';
import { modelDefaultsCatalog, modelLaunchCatalog, ModelDefaultsService } from '../../../src/services/model-defaults.js';
import { renderTomlForHost } from '../../../src/services/client-config.js';
import { buildModelPolicy } from '../../../src/services/model-policy.js';
import { createDbFake } from '../../helpers/db-fake.js';
const model = 'gpt-6.1-terra';
const render = (settings: unknown, version: string | null, override?: string | null) => renderTomlForHost({ settings, host: { clientVersion: version, modelOverride: override } as never, baseUrl:null, apiKey:null });
describe('Codex native model compatibility', () => {
  it.each([null, 'unknown', '0.158.9', '0.159.0-rc1'])('rejects unsupported or unreported native %s on effective root, override and profile', version => {
    expect(() => render({model}, version)).toThrow(/0\.159\.0.*cdx update/);
    expect(() => render({model:'gpt-6-astra'}, version, model)).toThrow(/0\.159\.0/);
    expect(() => render({model:'gpt-6-astra', profiles:[{name:'terra',model}]}, version)).toThrow(/0\.159\.0/);
  });
  it('keeps no-host authoring and unrelated/custom models independent of the new floor', async () => {
    expect(() => assertCodexModelVersion('custom-provider', null)).not.toThrow();
    expect(() => render({model:'gpt-6-astra'}, null)).not.toThrow();
    expect(() => render({model}, '0.158.0', 'gpt-6-astra')).not.toThrow();
    expect(() => render({model}, 'codex-cli 0.159.0')).not.toThrow();
    const defaults = new ModelDefaultsService(createDbFake() as never);
    expect(await defaults.set('codex',{model})).toMatchObject({model,reasoning_effort:'low'});
  });
  it('checks latest-only effective choices without inventing a minimum for the predecessor', () => {
    const settings={model:'gpt-5.6-terra'};
    expect(() => render(settings,'0.158.0')).not.toThrow();
    expect(() => renderTomlForHost({settings,host:{clientVersion:'0.158.0'} as never,baseUrl:null,apiKey:null,modelPolicy:buildModelPolicy('codex',true)})).toThrow(/0\.159\.0/);
  });
  it('advertises optional minimums globally and filters only incompatible signed host choices', () => {
    expect(modelDefaultsCatalog('codex').find(entry=>entry.model===model)?.min_cli_version).toBe('0.159.0');
    for(const version of [null,'0.158.0']) expect(modelLaunchCatalog('codex',undefined,version).models.map(entry=>entry.model)).not.toContain(model);
    expect(modelLaunchCatalog('codex',undefined,'0.159.0').models.find(entry=>entry.model===model)?.min_cli_version).toBe('0.159.0');
    for(const engine of ['claude','grok'] as const) expect(modelLaunchCatalog(engine,undefined,null)).toEqual(modelLaunchCatalog(engine));
  });
});
