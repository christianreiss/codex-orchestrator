/**
 * Reads and writes engine client/wrapper version metadata from the `versions`
 * table. /admin/versions/check additionally queries the upstream GitHub
 * release endpoint, caching the result back into `versions` under a key like
 * `github_release_<name>` with a 1-hour TTL.
 */

import { SettingsService } from './settings.js';
import { nowIso, parseIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';

// Widen the logger contract so any pino-compatible logger (Fastify's
// FastifyBaseLogger included) can be passed in.
type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export interface VersionSummary {
  client_version: string | null;
  wrapper_version: string | null;
  client_version_checked_at: string | null;
  client_version_lock: string | null;
  client_version_lock_updated_at: string | null;
  client_version_enforce_exact: boolean;
}

export interface AvailableRelease {
  name: string;
  version: string;
  url?: string | null;
  published_at?: string | null;
  fetched_at: string;
  cached: boolean;
}

const CACHE_TTL_SECONDS = 3600;

export class ClientVersionsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly log?: Logger,
  ) {}

  async versionSummary(engine: 'codex' | 'claude' = 'codex'): Promise<VersionSummary> {
    const prefix = engine === 'claude' ? 'claude_' : '';
    const [client, wrapper, checkedAt, lock] = await Promise.all([
      this.settings.getString(`${prefix}client_version`),
      this.settings.getString(`${prefix}wrapper_version`),
      this.settings.getString(`${prefix}client_version_checked_at`),
      this.settings.getWithMeta(`${prefix}client_version_lock`),
    ]);
    return {
      client_version: client,
      wrapper_version: wrapper,
      client_version_checked_at: checkedAt,
      client_version_lock: lock.value,
      client_version_lock_updated_at: lock.updatedAt,
      client_version_enforce_exact: await this.settings.getFlag(
        `${prefix}client_version_enforce_exact`,
        false,
      ),
    };
  }

  async availableClientVersion(force = false, engine = 'codex'): Promise<AvailableRelease | null> {
    const releaseName = engine === 'claude' ? 'claude-cli' : 'codex-cli';
    const cacheKey = `github_release_${releaseName}`;
    const cached = await this.settings.getWithMeta(cacheKey);
    if (!force && cached.value && cached.updatedAt) {
      const updatedTs = parseIso(cached.updatedAt)?.getTime() ?? 0;
      const age = (Date.now() - updatedTs) / 1000;
      if (age < CACHE_TTL_SECONDS) {
        const parsed = this.safeParse(cached.value);
        if (parsed) return parsed;
      }
    }
    const fresh = await this.fetchUpstream(releaseName);
    if (fresh) {
      await this.settings.set(cacheKey, JSON.stringify(fresh), { publish: false });
      return { ...fresh, cached: false };
    }
    return cached.value ? this.safeParse(cached.value) : null;
  }

  private safeParse(raw: string): AvailableRelease | null {
    try {
      const parsed = JSON.parse(raw) as AvailableRelease;
      return { ...parsed, cached: true };
    } catch {
      return null;
    }
  }

  private async fetchUpstream(name: string): Promise<AvailableRelease | null> {
    const repo = name === 'claude-cli' ? 'anthropics/claude-cli' : 'openai/codex-cli';
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      let resp: Response | null = null;
      try {
        resp = await fetch(url, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'codex-orchestrator' },
          signal: ac.signal,
        });
      } catch (err) {
        this.log?.warn?.({ err, name }, 'github release fetch failed');
        resp = null;
      } finally {
        clearTimeout(timer);
      }
      if (!resp || !resp.ok) return null;
      const json = (await resp.json()) as {
        tag_name?: string;
        name?: string;
        html_url?: string;
        published_at?: string;
      };
      const version = (json.tag_name ?? json.name ?? '').replace(/^v/, '').trim();
      if (!version) return null;
      return {
        name,
        version,
        url: json.html_url ?? null,
        published_at: json.published_at ?? null,
        fetched_at: nowIso(),
        cached: false,
      };
    } catch (err) {
      this.log?.warn?.({ err, name }, 'github release fetch errored');
      return null;
    }
  }

  async setCodexVersionLock(
    value: string | null,
  ): Promise<{ locked_version: string | null; locked_at: string | null }> {
    if (value === null) {
      await this.settings.delete('client_version_lock');
    } else {
      await this.settings.set('client_version_lock', value);
    }
    wsPublisher.publish('settings.changed', { key: 'client_version_lock' });
    const meta = await this.settings.getWithMeta('client_version_lock');
    return { locked_version: meta.value, locked_at: meta.updatedAt };
  }
}

export function isSemanticVersion(s: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(s);
}

export function normalizeVersion(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const trimmed = String(s).trim().replace(/^v/i, '');
  return trimmed === '' ? null : trimmed;
}
