import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';

export function attachShutdown(app: FastifyInstance, pool?: Pool): void {
  const close = async (signal: string) => {
    app.log.info({ signal }, 'shutdown requested');
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'error closing fastify');
    }
    try {
      await pool?.end();
    } catch (err) {
      app.log.error({ err }, 'error closing db pool');
    }
    process.exit(0);
  };
  const interrupt = () => void close('SIGINT'), terminate = () => void close('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  app.addHook('onClose', async () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); });
}
