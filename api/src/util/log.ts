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
        '*.api_key',
        '*.token',
      ],
      remove: true,
    },
    transport,
  };
}

