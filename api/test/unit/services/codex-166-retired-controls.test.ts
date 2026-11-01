import { describe, expect, it } from 'vitest';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';

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
          const path = `${profile && !native ? 'settings.profiles[0].' : native ? 'native_settings.' : 'settings.'}features.${field}`;
          it(`rejects ${field}=${value} in ${native ? 'native' : 'structured'} ${profile ? 'profile' : 'root'}`, () => {
            expect(() => service.render(settings)).toThrow(new RegExp(field.replaceAll('.', '\\.')));
            try { service.render(settings); } catch (error) { expect(error).toMatchObject({ param: path }); }
            // Also prevent callers using the normalizer directly from losing input.
            expect(() => normalizeSettings(settings)).toThrow(/removed|deprecated|ignored/);
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
});
