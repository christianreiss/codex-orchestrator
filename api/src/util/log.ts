import pino, { type Logger } from 'pino';
import type { Env } from '../env.js';

export function createLogger(env: Env): Logger {
  const transport =
    env.LOG_PRETTY && env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined;

  return pino({
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
  });
}
