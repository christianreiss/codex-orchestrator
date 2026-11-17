import { posix, win32 } from 'node:path';
import { ValidationError } from '../http/errors.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value as RecordValue;
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const reserved = new Set(['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length',
  'transfer-encoding', 'connection', 'upgrade', 'chatgpt-account-id']);

function invalid(field: string, reason: string): never {
  // Values may contain credentials: report only the setting path and rule.
  throw new ValidationError(`${field}: ${reason}`, { param: field });
}

/** codex-rs/http-client::validate_endpoint_url, rust-v0.169.0. */
function endpoint(value: unknown, field: string): URL {
  let url: URL | undefined;
  if (typeof value === 'string') {
    try { url = new URL(value); } catch { /* sanitized field error below */ }
  }
  const host = url?.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host ?? '');
  if (!url || !host || url.username || url.password || String(value).includes('#')
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    invalid(field, 'expected HTTPS (or loopback HTTP), without user information or a fragment');
  }
  return url;
}

/** Native cross-field constraints absent from the published JSON schema.
 * Source: codex-rs/model-provider-info/src/gateway_oauth.rs, rust-v0.169.0.
 * Caller has already checked schema types and built-in provider restrictions.
 */
export function validateCodexGatewayOAuth(provider: RecordValue, field: string): void {
  if (!Object.hasOwn(provider, 'gateway_oauth')) return;
  const oauth = record(provider.gateway_oauth), oauthField = `${field}.gateway_oauth`;
  if (Object.hasOwn(provider, 'aws') || ['Amazon Bedrock', 'Amazon Bedrock Runtime'].includes(String(provider.name))) {
    invalid(oauthField, 'cannot be combined with AWS authentication');
  }
  if (!Object.hasOwn(provider, 'base_url')) invalid(oauthField, 'requires base_url');
  const gateway = endpoint(provider.base_url, `${field}.base_url`);
  const exported = Object.hasOwn(oauth, 'credential_export');
  if (exported) {
    const command = String(record(oauth.credential_export).command);
    // A path valid on either native platform stays authorable; never execute it.
    const absolute = posix.isAbsolute(command) || (win32.isAbsolute(command) && win32.parse(command).root.length > 1);
    if (!command.trim() || (!absolute && (command.includes('/') || command === '.' || command === '..'))) {
      invalid(`${oauthField}.credential_export.command`, 'expected a nonempty absolute path or bare executable name on the native host');
    }
  } else {
    endpoint(oauth.authorization_url, `${oauthField}.authorization_url`);
    endpoint(oauth.token_url, `${oauthField}.token_url`);
    if (Object.hasOwn(oauth, 'device_authorization_url')) endpoint(oauth.device_authorization_url, `${oauthField}.device_authorization_url`);
    if (!String(oauth.client_id).trim()) invalid(`${oauthField}.client_id`, 'expected a nonempty client_id');
    if (oauth.redirect_port === 0) invalid(`${oauthField}.redirect_port`, 'expected a nonzero redirect_port');
  }
  const delivery = oauth.delivery === undefined ? { kind: 'header', name: 'Authorization', scheme: 'Bearer' } : record(oauth.delivery);
  const name = String(delivery.name).toLowerCase();
  const scheme = delivery.scheme === undefined ? 'Bearer' : String(delivery.scheme);
  const primary = delivery.kind === 'header' && name === 'authorization' && scheme.toLowerCase() === 'bearer';
  if ((primary || exported) && Object.hasOwn(provider, 'model_catalog_url')) {
    const catalog = endpoint(provider.model_catalog_url, `${field}.model_catalog_url`);
    if (catalog.origin !== gateway.origin) invalid(`${field}.model_catalog_url`, 'gateway credentials require the same scheme, host, and port as base_url; remove this override to use the gateway catalog');
  }
  let header = name;
  if (primary) {
    if (provider.name === 'Google Cloud Vertex AI') invalid(oauthField, 'Google Cloud owns the Authorization header; choose custom gateway delivery');
    if (provider.requires_openai_auth === true || ['env_key', 'experimental_bearer_token', 'auth'].some(key => Object.hasOwn(provider, key))) {
      invalid(`${oauthField}.delivery`, 'the model provider credential and gateway token conflict in Authorization; choose a custom header or cookie accepted by the gateway');
    }
  } else if (delivery.kind === 'cookie') {
    if (!token.test(String(delivery.name))) invalid(`${oauthField}.delivery`, 'expected a valid cookie name');
    header = 'cookie';
  } else if (!token.test(String(delivery.name)) || reserved.has(name)
    || ['x-codex-', 'x-openai-', 'sec-websocket-'].some(prefix => name.startsWith(prefix)) || !token.test(scheme)) {
    invalid(`${oauthField}.delivery`, 'expected an unreserved HTTP header name and valid authentication scheme');
  }
  for (const key of ['http_headers', 'env_http_headers']) {
    if (provider[key] !== undefined && Object.keys(record(provider[key])).some(key => key.toLowerCase() === header)) {
      invalid(`${field}.${key}`, 'duplicate gateway delivery header; remove the provider header or choose another gateway delivery');
    }
  }
}
