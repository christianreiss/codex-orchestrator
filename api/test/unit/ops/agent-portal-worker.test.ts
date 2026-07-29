import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../src/env.js';
import {
  matrixDeliveryIdempotencyKey,
  sendMatrixDelivery,
} from '../../../src/ops/agent-portal-worker.js';
import type { MatrixDelivery } from '../../../src/services/agent-portal.js';

const env = {
  MATRIX_API_URL: 'https://matrix.example/api',
  MATRIX_API_KEY: 'matrix-secret',
  AGENT_PORTAL_MATRIX_TIMEOUT_SECONDS: 10,
} as Env;

function delivery(id: number, room: string): MatrixDelivery {
  return {
    id,
    event_key: 'same-agent-event',
    idempotency_key: `agent-portal:test-${id}`,
    matrix_room: room,
    magic_url: `https://portal.example/go/u/${id}#t=secret-${id}`,
    payload: { kind: 'attention', title: 'Codex', status: 'Needs attention' },
    attempts: 1,
    lease_owner: `lease-${id}`,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent portal Matrix delivery idempotency', () => {
  it('uses one stable globally unique key per outbox row across recipients and retries', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await sendMatrixDelivery(env, delivery(41, 'alice'));
    await sendMatrixDelivery(env, delivery(42, 'bob'));
    await sendMatrixDelivery(env, delivery(41, 'alice'));

    expect(bodies.map((body) => body.idempotency_key)).toEqual([
      'agent-portal:test-41',
      'agent-portal:test-42',
      'agent-portal:test-41',
    ]);
    expect(bodies[0]!.message).not.toBe(bodies[1]!.message);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(matrixDeliveryIdempotencyKey(delivery(41, 'alice'))).toBe('agent-portal:test-41');
  });
});
