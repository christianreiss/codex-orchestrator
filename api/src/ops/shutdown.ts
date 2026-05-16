import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';

export function attachShutdown(app: FastifyInstance, pool: Pool): void {
  const close = async (signal: string) => {
    app.log.info({ signal }, 'shutdown requested');
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'error closing fastify');
    }
    try {
      await pool.end();
    } catch (err) {
      app.log.error({ err }, 'error closing db pool');
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void close('SIGINT'));
  process.once('SIGTERM', () => void close('SIGTERM'));
}
