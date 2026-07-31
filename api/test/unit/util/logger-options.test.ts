import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { loggerOptions } from '../../../src/util/log.js';
import type { Env } from '../../../src/env.js';

function env(over: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'development',
    APP_ENV: 'development',
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
    ...over,
  } as unknown as Env;
}

/**
 * Logs `payload` through a real pino built from the returned options and gives
 * back the parsed line, so the assertions below are about what actually reaches
 * the log stream rather than about the shape of the options literal.
 */
function emit(payload: Record<string, unknown>, over: Partial<Env> = {}): Record<string, unknown> {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  pino(loggerOptions(env(over)), stream).info(payload, 'hello');
  const written = chunks.join('').trim();
  expect(written.split('\n')).toHaveLength(1);
  return JSON.parse(written) as Record<string, unknown>;
}

function written(line: Record<string, unknown>): string {
  return JSON.stringify(line);
}

/** Every field the `*.<field>` wildcard paths claim to strip. */
const SECRET_FIELDS = [
  'password',
  'passwordHash',
  'apiKey',
  'apiKeyEnc',
  'apiKeyHash',
  'token',
  'tokenEnc',
  'tokenHash',
  'accessToken',
  'refreshToken',
  'valueEnc',
  'value_enc',
  'secretValue',
] as const;

describe('loggerOptions transport', () => {
  it('attaches pino-pretty when LOG_PRETTY is set outside production', () => {
    expect(loggerOptions(env({ LOG_PRETTY: true })).transport).toEqual({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    });
  });

  it.each<[string, Partial<Env>]>([
    ['LOG_PRETTY off, development', { LOG_PRETTY: false, NODE_ENV: 'development' }],
    ['LOG_PRETTY off, production', { LOG_PRETTY: false, NODE_ENV: 'production' }],
    // The one that matters: pretty logging is a developer convenience and must
    // never load the transport in production, however LOG_PRETTY got set.
    ['LOG_PRETTY on, production', { LOG_PRETTY: true, NODE_ENV: 'production' }],
  ])('leaves transport undefined for %s', (_name, over) => {
    expect(loggerOptions(env(over)).transport).toBeUndefined();
  });
});

describe('loggerOptions level and base', () => {
  it('tracks LOG_LEVEL and APP_ENV', () => {
    const opts = loggerOptions(env({ LOG_LEVEL: 'debug', APP_ENV: 'staging' }));
    expect(opts.level).toBe('debug');
    expect(opts.base).toEqual({ app: 'codex-orchestrator-api', env: 'staging' });
  });

  it('keeps the app name fixed regardless of environment', () => {
    expect(loggerOptions(env({ APP_ENV: 'production' })).base).toEqual({
      app: 'codex-orchestrator-api',
      env: 'production',
    });
  });
});

describe('loggerOptions redaction', () => {
  it('removes the credential request headers instead of censoring them', () => {
    const line = emit({
      req: {
        headers: {
          authorization: 'Bearer super-secret',
          'x-api-key': 'sk-codex-super-secret',
          cookie: 'codex_admin_session=super-secret',
          'user-agent': 'vitest',
        },
      },
    });

    expect(line.req).toEqual({ headers: { 'user-agent': 'vitest' } });
    // `remove: true` deletes the key; a `[Redacted]` placeholder would still
    // tell a log reader the header was present.
    expect(written(line)).not.toContain('Redacted');
    expect(written(line)).not.toContain('super-secret');
  });

  it('removes every wildcard secret field nested one level deep', () => {
    const secrets = Object.fromEntries(SECRET_FIELDS.map((field) => [field, `super-secret-${field}`]));
    const line = emit({
      host: { ...secrets, name: 'runner-1' },
      credential: { ...secrets, email: 'ops@example.test' },
    });

    expect(line.host).toEqual({ name: 'runner-1' });
    expect(line.credential).toEqual({ email: 'ops@example.test' });
    expect(written(line)).not.toContain('super-secret');
  });

  it('emits the level as its string label', () => {
    expect(emit({}).level).toBe('info');
    expect(emit({}, { LOG_LEVEL: 'trace' }).level).toBe('info');
  });

  it('does not reach top-level or doubly-nested secrets', () => {
    // pino's `*` matches exactly one level, so these shapes survive. Pinned so a
    // change to the paths list is a deliberate decision, not a surprise.
    const line = emit({ password: 'top-level', req: { body: { auth: { token: 'deep' } } } });

    expect(line.password).toBe('top-level');
    expect(line.req).toEqual({ body: { auth: { token: 'deep' } } });
  });

  it('strips the fleet-secrets create/update plaintext, which no wildcard reaches', () => {
    // `req.body.value` sits three levels deep, so it is spelled out in full
    // rather than covered by `*.value` — which `remove: true` would make far too
    // destructive, deleting legitimate `{setting:{value}}` shapes everywhere.
    const line = emit({ req: { body: { slug: 'gh-pat', value: 'ghp_super-secret' } } });

    expect(line.req).toEqual({ body: { slug: 'gh-pat' } });
    expect(written(line)).not.toContain('ghp_super-secret');
  });

  it('leaves an unrelated one-level `value` alone', () => {
    // The other half of the same decision: over-broad redaction is its own bug.
    const line = emit({ setting: { value: 'normal-mode' } });
    expect(line.setting).toEqual({ value: 'normal-mode' });
  });
});
