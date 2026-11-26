/**
 * The one undici `Agent` the upstream path uses, for forwarded requests and
 * key verification alike, so both go through the same guarded connector.
 * undici's `request()` does not follow redirects and does not decompress, which
 * is what a 1:1 forward needs; global `fetch` does both.
 */
import { Agent } from 'undici';
import type { Env } from '../../env.js';
import { createGuardedConnector, ownHostsFrom, parseHostList, type UpstreamNetworkPolicy } from './base-url.js';

export interface UpstreamConfig {
  replayBytes: number;
  maxUploadBytes: number;
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  bodyIdleTimeoutMs: number;
  policy: UpstreamNetworkPolicy;
}

const MIB = 1024 * 1024;

/** Defaults apply to anything the env leaves out (tests pass a partial env). */
export function upstreamConfigFromEnv(env: Partial<Env> | undefined): UpstreamConfig {
  const e = (env ?? {}) as Partial<Env>;
  const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  return {
    replayBytes: num(e.GATEWAY_UPSTREAM_REPLAY_BYTES, 8 * MIB),
    maxUploadBytes: num(e.GATEWAY_UPSTREAM_MAX_UPLOAD_BYTES, 512 * MIB),
    connectTimeoutMs: num(e.GATEWAY_UPSTREAM_CONNECT_TIMEOUT, 10) * 1000,
    headersTimeoutMs: num(e.GATEWAY_UPSTREAM_HEADERS_TIMEOUT, 900) * 1000,
    bodyIdleTimeoutMs: num(e.GATEWAY_UPSTREAM_BODY_IDLE_TIMEOUT, 300) * 1000,
    policy: {
      privateHosts: parseHostList(e.GATEWAY_UPSTREAM_PRIVATE_HOSTS),
      ownHosts: ownHostsFrom(e.PUBLIC_BASE_URL, e.CONNECTOR_PUBLIC_BASE_URL, e.ADMIN_WS_PUBLIC_URL),
    },
  };
}

export function createUpstreamAgent(config: UpstreamConfig): Agent {
  return new Agent({
    connect: createGuardedConnector(config.policy, { connectTimeoutMs: config.connectTimeoutMs }),
    headersTimeout: config.headersTimeoutMs,
    bodyTimeout: config.bodyIdleTimeoutMs,
  });
}
