import type { Database } from '../db/client.js';
import { ENGINES, type Engine } from '../util/engine.js';
import { SettingsService } from './settings.js';

export function resolveSpeechInput(global: string | null, override: string | null) {
  const defaultEnabled = global !== 'false';
  const selected = override === 'true' ? true : override === 'false' ? false : null;
  return { enabled: selected ?? defaultEnabled, override: selected, global: defaultEnabled };
}
export async function speechInputPolicy(db: Database, engine: Engine) {
  const settings = new SettingsService(db);
  const policy = resolveSpeechInput(await settings.getRaw('speech_input_global'), await settings.getRaw(`speech_input_${engine}`));
  return { ...policy, supported: engine !== 'kimi', activation: engine === 'claude' ? '/voice hold' : engine === 'kimi' ? null : '/voice', control: engine === 'claude' ? 'native' : engine === 'grok' ? 'shortcut' : 'unavailable' };
}
export async function speechInputPolicies(db: Database) {
  return { engines: Object.fromEntries(await Promise.all(ENGINES.map(async engine => [engine, await speechInputPolicy(db, engine)]))) };
}
