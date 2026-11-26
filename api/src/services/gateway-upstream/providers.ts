/**
 * The four upstream providers behind the gateway surfaces. Each surface has
 * exactly one, fixed: a surface whose source is `upstream` forwards to this
 * provider and nothing else (see `api-surfaces.ts`), and its fleet engine
 * master switch gates the provider path too.
 *
 * | Surface         | Provider  | Default base                   | Auth        | Engine |
 * |-----------------|-----------|--------------------------------|-------------|--------|
 * | `/v1`           | openai    | https://api.openai.com/v1      | Bearer      | codex  |
 * | `/anthropic/v1` | anthropic | https://api.anthropic.com/v1   | `x-api-key` | claude |
 * | `/grok/v1`      | xai       | https://api.x.ai/v1            | Bearer      | grok   |
 * | `/kimi/v1`      | moonshot  | https://api.moonshot.ai/v1     | Bearer      | kimi   |
 */
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, ENGINE_KIMI, type Engine } from '../../util/engine.js';

export type ProviderId = 'openai' | 'anthropic' | 'xai' | 'moonshot';
export const PROVIDER_IDS: readonly ProviderId[] = ['openai', 'anthropic', 'xai', 'moonshot'];

export type ProviderAuthStyle = 'bearer' | 'x-api-key';

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  /** Fleet engine whose master switch also gates this provider's upstream path. */
  engine: Engine;
  /** Used when a key has no `base_url` of its own. No trailing slash. */
  defaultBaseUrl: string;
  auth: ProviderAuthStyle;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  openai: { id: 'openai', label: 'OpenAI', engine: ENGINE_CODEX, defaultBaseUrl: 'https://api.openai.com/v1', auth: 'bearer' },
  anthropic: { id: 'anthropic', label: 'Anthropic', engine: ENGINE_CLAUDE, defaultBaseUrl: 'https://api.anthropic.com/v1', auth: 'x-api-key' },
  xai: { id: 'xai', label: 'xAI', engine: ENGINE_GROK, defaultBaseUrl: 'https://api.x.ai/v1', auth: 'bearer' },
  moonshot: { id: 'moonshot', label: 'Moonshot AI', engine: ENGINE_KIMI, defaultBaseUrl: 'https://api.moonshot.ai/v1', auth: 'bearer' },
};

/** Sent when an Anthropic-wire client omitted `anthropic-version`; the API requires one. */
export const ANTHROPIC_DEFAULT_VERSION = '2023-06-01';

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** The upstream auth header for one key; nothing else ever carries the key. */
export function providerAuthHeaders(provider: ProviderId, key: string): Record<string, string> {
  return PROVIDERS[provider].auth === 'x-api-key' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` };
}
