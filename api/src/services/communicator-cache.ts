import { createHash } from 'node:crypto';
import { inspectCredential } from './auth-generation.js';
import type { Engine } from '../util/engine.js';

export const COMMUNICATOR_CACHE_PROTOCOL = 2;
// A confirmation is for one request, never a lease for subsequent reads.
export const CACHE_CONFIRMATION_MS = 30_000;

export interface CacheResource {
  path: string[];
  revision: string;
  sha256: string;
  valid_until: string | null;
  content?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extract only immutable content bytes. Status, admission, quota and RPC IDs stay live. */
export function cacheManifest(
  body: unknown,
  known: Record<string, string>,
  engine: Engine,
  secure: boolean,
  checkedAt: number,
): { body: unknown; resources: CacheResource[]; valid_for_ms: number } {
  const resources: CacheResource[] = [];
  let validForMs = CACHE_CONFIRMATION_MS;
  function visit(value: unknown, path: string[], parent: Record<string, unknown> | null): unknown {
    const field = path.at(-1);
    let expiry: string | null = null;
    let cacheable =
      secure &&
      ((typeof value === 'string' && (field === 'content' || field === 'manifest')) ||
        (field === 'result' && parent?.jsonrpc === '2.0'));
    if (field === 'auth' && record(value) && parent?.verification_state === 'verified') {
      const identity = inspectCredential(value as Record<string, unknown>, engine);
      expiry = identity?.accessExpiresAt ?? null;
      // Opaque/API-key credentials have no provable expiry: deliver fresh, never retain.
      cacheable = secure && expiry !== null && Date.parse(expiry) > checkedAt;
      // Only retained bytes can shorten the proof budget. An uncached native
      // refresh package is fresh inline data, even when its access token expired.
      if (cacheable) validForMs = Math.min(validForMs, Date.parse(expiry!) - checkedAt);
    }
    if (cacheable) {
      const raw = Buffer.from(JSON.stringify(value));
      const sha = createHash('sha256').update(raw).digest('hex');
      const key = JSON.stringify(path);
      resources.push({
        path,
        revision: sha,
        sha256: sha,
        valid_until: expiry,
        ...(known[key] === sha ? {} : { content: raw.toString('base64') }),
      });
      return null;
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, String(index)], null));
    const obj = record(value);
    if (!obj) return value;
    return Object.fromEntries(
      Object.entries(obj).map(([key, child]) => [key, visit(child, [...path, key], obj)]),
    );
  }
  const template = visit(body, [], null);
  return { body: template, resources, valid_for_ms: Math.max(0, validForMs) };
}

/** Only these MCP reads may use this protocol; arbitrary tools keep their exact transport semantics. */
export function cacheableMcp(body: Record<string, unknown>): boolean {
  if (body.jsonrpc !== '2.0' || !('id' in body) || !['string', 'number'].includes(typeof body.id))
    return false;
  const params = record(body.params);
  if (body.method === 'resources/read')
    return typeof params?.uri === 'string' && params.uri.startsWith('skill://');
  if (body.method !== 'tools/call') return false;
  if (params?.name === 'skill_list' || params?.name === 'skill_retrieve') return true;
  const args = record(params?.arguments);
  return params?.name === 'resource_read' && typeof args?.uri === 'string' && args.uri.startsWith('skill://');
}

export function cacheSourceAllowed(method: string, path: string, body: Record<string, unknown>): boolean {
  if (!path.startsWith('/') || /[%\\#]/.test(path) || path.includes('//')) return false;
  const url = new URL(path, 'http://cache.local');
  if (
    [...url.searchParams.keys()].some((key) => key !== 'engine') ||
    url.searchParams.getAll('engine').length > 1
  )
    return false;
  path = url.pathname;
  if (method === 'GET') return /^\/skills(?:\/[A-Za-z0-9._-]+)?$/.test(path);
  if (method !== 'POST') return false;
  if (path === '/mcp') return cacheableMcp(body);
  if (path === '/auth') return body.command === undefined || body.command === 'retrieve';
  return [
    '/auth/sessions',
    '/sync/bootstrap',
    '/agents/retrieve',
    '/config/retrieve',
    '/skills/retrieve',
  ].includes(path);
}
