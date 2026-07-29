import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { createAgentPortalService, type MatrixDelivery } from '../services/agent-portal.js';

/**
 * DB-backed Matrix delivery + retention worker. Database rows are the source of
 * truth; the timer is only a wake-up mechanism, so process restarts merely
 * release expired leases and continue.
 */
export function startAgentPortalWorker(
  app: FastifyInstance,
  db: Database,
  env: Env,
  keyring: Keyring,
): void {
  const portal = createAgentPortalService(db, env, keyring);
  const workerId = `api-${process.pid}`;
  let stopped = false;
  let running = false;
  let lastPurge = 0;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      if (Date.now() - lastPurge >= 5 * 60_000) {
        lastPurge = Date.now();
        const purged = await portal.purgeExpired();
        if (purged.sessions || purged.browser_sessions || purged.abandoned_sessions) {
          app.log.info({ purged }, 'agent portal retention purge');
        }
      }
      if (!env.MATRIX_API_URL || !env.MATRIX_API_KEY) return;
      for (let i = 0; i < 20; i += 1) {
        const delivery = await portal.claimMatrixDelivery(workerId);
        if (!delivery) break;
        try {
          await sendMatrixDelivery(env, delivery);
          await portal.completeMatrixDelivery(delivery.id, delivery.lease_owner);
        } catch (error) {
          const message = safeError(error);
          await portal.failMatrixDelivery(delivery.id, delivery.lease_owner, delivery.attempts, message);
          app.log.warn({ outbox_id: delivery.id, attempts: delivery.attempts, error: message }, 'agent portal Matrix delivery failed');
        }
      }
    } catch (error) {
      app.log.error({ err: error }, 'agent portal worker tick failed');
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void tick(), env.AGENT_PORTAL_MATRIX_WORKER_INTERVAL_SECONDS * 1000);
  interval.unref();
  void tick();
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(interval);
  });
}

export async function sendMatrixDelivery(env: Env, delivery: MatrixDelivery): Promise<void> {
  const plain = renderPlain(delivery);
  const html = renderHtml(delivery);
  const response = await fetch(env.MATRIX_API_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      api_key: env.MATRIX_API_KEY,
      room: delivery.matrix_room,
      message: plain,
      html,
      msg_type: 'm.text',
      // The encrypted outbox envelope owns this random logical-delivery key,
      // so retries remain byte-identical even after backup restore or user
      // room/link changes.
      idempotency_key: matrixDeliveryIdempotencyKey(delivery),
    }),
    signal: AbortSignal.timeout(env.AGENT_PORTAL_MATRIX_TIMEOUT_SECONDS * 1000),
  });
  if (!response.ok) throw new Error(`Matrix API HTTP ${response.status}`);
  const body = (await response.json().catch(() => null)) as { success?: unknown } | null;
  if (!body || body.success !== true) throw new Error('Matrix API rejected delivery');
}

export function matrixDeliveryIdempotencyKey(delivery: Pick<MatrixDelivery, 'idempotency_key'>): string {
  return delivery.idempotency_key;
}

function renderPlain(delivery: MatrixDelivery): string {
  const lines = [delivery.payload.title, delivery.payload.status];
  if (delivery.payload.summary) lines.push(delivery.payload.summary);
  lines.push(delivery.magic_url);
  return lines.join('\n');
}

function renderHtml(delivery: MatrixDelivery): string {
  const title = escapeHtml(delivery.payload.title);
  const status = escapeHtml(delivery.payload.status);
  const summary = delivery.payload.summary ? `<br>${escapeHtml(delivery.payload.summary)}` : '';
  const link = escapeHtml(delivery.magic_url);
  return `<strong>${title}</strong><br>${status}${summary}<br><a href="${link}">Open agent portal</a>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}
