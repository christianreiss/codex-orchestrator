import { describe, expect, it } from 'vitest';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { createHash } from 'node:crypto';

const service = new ClientConfigService({} as never);
describe('Codex 0.166 retired controls', () => {
  // Native features/lib.rs marks CodeModeToolDescriptionFirst Stage::Removed;
  // GuardianV2Config.async_classifier_mode remains schema-compatible but ignored.
  for (const value of [false, true, 'snapshot', 'conversation']) {
    for (const field of ['code_mode_tool_description_first', 'guardianv2.async_classifier_mode']) {
      const features = field.includes('.') ? { guardianv2: { async_classifier_mode: value } } : { [field]: value };
      for (const native of [false, true]) {
        for (const profile of [false, true]) {
          const scope = native ? { native_settings: { features } } : { features };
          const settings = profile ? { profiles: [{ name: 'review', ...scope }] } : scope;
          const path = `${profile ? 'settings.profiles[0].' : native ? '' : 'settings.'}${native ? 'native_settings.' : ''}features.${field}`;
          it(`rejects ${field}=${value} in ${native ? 'native' : 'structured'} ${profile ? 'profile' : 'root'}`, () => {
            expect(() => service.render(settings)).toThrow(new RegExp(field.replaceAll('.', '\\.')));
            try { service.render(settings); } catch (error) { expect(error).toMatchObject({ param: path }); }
            // Stored compatibility heals exact retired paths without mutating
            // the source. New authoring above must still reject those values.
            const before = structuredClone(settings);
            const stored = normalizeSettings(settings);
            const healed = profile ? stored.profiles[0]! : stored;
            const healedFeatures = (native ? healed.native_settings as Record<string, unknown> : healed).features as Record<string, unknown>;
            if (field.includes('.')) expect(healedFeatures.guardianv2).toEqual({});
            else expect(healedFeatures).not.toHaveProperty(field);
            expect(settings).toEqual(before);
          });
        }
      }
    }
  }
  it('keeps live Guardian settings and literal map names with retired-looking text', () => {
    const native = { features: { guardianv2: { enabled: false, async_classifier_conversation_token_limit: 1 } },
      mcp_servers: { 'features.code_mode_tool_description_first': { command: '/bin/echo' } },
      plugins: { 'guardianv2.async_classifier_mode@test': { enabled: false } } };
    expect(normalizeCodexNativeSettings(native)).toEqual(native);
    const rendered = service.render({ native_settings: native, profiles: [{ name: 'review', native_settings: native }] });
    expect(rendered.content).toContain('async_classifier_conversation_token_limit = 1');
    expect(rendered.profiles?.[0]?.content).toContain('enabled = false');
  });
  it('heals saved settings on read while preserving historical body/hash and rejecting new stores', async () => {
    const features = { code_mode_tool_description_first: false, guardianv2: { async_classifier_mode: 'snapshot', enabled: false } };
    const settings = { features, native_settings: { features }, profiles: [{ name: 'review', features, native_settings: { features } }] };
    const body = '# historical body\ncode_mode_tool_description_first = false';
    const sha256 = createHash('sha256').update(body).digest('hex');
    const row = { id: 1, engine: 'codex', settings, body, sha256,
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
    const db = createDbFake(new Map([[clientConfigDocuments, [row]]]));
    const configs = new ClientConfigService(db as never);
    const fetched = await configs.adminFetch();
    expect(fetched.content).toBe(body);
    expect(fetched.sha256).toBe(sha256);
    expect(fetched.validation_error).toBeUndefined();
    expect(db.tables.get(clientConfigDocuments)).toEqual([row]);
    for (const scope of [fetched.settings!, fetched.settings!.profiles[0]!]) {
      expect(scope.features).toEqual({ guardianv2: { enabled: false } });
      expect(scope.native_settings).toEqual({ features: { guardianv2: { enabled: false } } });
    }
    await expect(configs.store({ settings })).rejects.toThrow(/code_mode_tool_description_first/);
    const saved = await configs.store({ settings: fetched.settings, expected_revision: fetched.revision });
    expect(saved.change).toBe('updated');
    expect(saved.content).not.toMatch(/^(code_mode_tool_description_first|async_classifier_mode) =/m);
  });
});
