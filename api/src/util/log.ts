import { type LoggerOptions } from 'pino';
import type { Env } from '../env.js';

/** Build the pino options object Fastify expects in its `logger` field. */
export function loggerOptions(env: Env): LoggerOptions {
  const transport =
    env.LOG_PRETTY && env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined;

  return {
    level: env.LOG_LEVEL,
    base: {
      app: 'codex-orchestrator-api',
      env: env.APP_ENV,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers.cookie',
        '*.password',
        '*.passwordHash',
        '*.apiKey',
        '*.apiKeyEnc',
        '*.apiKeyHash',
        '*.token',
        '*.tokenEnc',
        '*.tokenHash',
        '*.accessToken',
        '*.refreshToken',
        // Fleet secrets store. `valueEnc`/`value_enc` is the ciphertext on a raw
        // row and its snake_case shadow; `secretValue` covers the shapes that
        // spell it out. `req.body.value` is written in full because pino's `*`
        // matches exactly one level and the create/update plaintext sits three
        // deep, past the wildcard's reach.
        //
        // A bare `*.value` is deliberately absent: `remove: true` deletes the
        // key outright, so it would silently strip legitimate `{setting:{value}}`
        // and `{header:{value}}` shapes out of unrelated log lines.
        '*.valueEnc',
        '*.value_enc',
        '*.secretValue',
        'req.body.value',
      ],
      remove: true,
    },
    transport,
  };
}

