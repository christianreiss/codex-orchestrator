import type { Host } from '../db/schema.js';
import { ValidationError } from '../http/errors.js';
import type { Engine } from '../util/engine.js';
import { versionCompare } from './wrapper-bin-registry.js';

/** Audited native schemas are a capability baseline, not a universal CLI floor. */
export const NATIVE_CONFIG_MIN_VERSIONS = { codex: '0.162.1', claude: '2.1.296' } as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function assertNativeConfigSupport(settings: unknown, host: Host | null, engine: Engine): void {
  if (!host || engine === 'grok') return;
  const value = record(settings);
  const root = Object.keys(record(value.native_settings)).length > 0;
  const profile = engine === 'codex' && Array.isArray(value.profiles)
    && value.profiles.some(p => Object.keys(record(record(p).native_settings)).length > 0);
  if (!root && !profile) return;
  const raw = engine === 'codex' ? host.clientVersion : host.claudeClientVersion;
  const observed = typeof raw === 'string' ? raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] : undefined;
  const minimum = NATIVE_CONFIG_MIN_VERSIONS[engine];
  if (!observed || versionCompare(observed, minimum) < 0) {
    throw new ValidationError(`${engine} native settings require CLI ${minimum} or newer; observed ${observed ?? 'unreported'}. Run ${engine === 'codex' ? 'cdx' : 'clx'} update (or cron run to report an already installed version), then retry sync.`, {
      param: root ? 'settings.native_settings' : 'settings.profiles',
    });
  }
}
