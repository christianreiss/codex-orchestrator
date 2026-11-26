/**
 * The request body of an upstream forward.
 *
 * - JSON / text bodies of the named routes were already read by the gateway
 *   body capture (`req.gatewayRawBody`): forwarded byte for byte, replayable.
 * - Every other body (catch-all paths, multipart uploads) is still unread on
 *   `req.raw`. Up to `replayBytes` it is buffered and replayable; a larger one
 *   streams once, without failover, and is capped at `maxUploadBytes`.
 */
import { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../../http/errors.js';

export type UpstreamBody =
  | { kind: 'none' }
  | { kind: 'buffer'; bytes: Buffer }
  | { kind: 'stream'; stream: Readable; length: number | null };

export class UploadTooLargeError extends ApiError {
  constructor() {
    super('Request body exceeds the gateway upload limit', {
      status: 413,
      code: 'payload_too_large',
      type: 'invalid_request_error',
    });
  }
}

export function isReplayable(body: UpstreamBody): boolean {
  return body.kind !== 'stream';
}

export async function readUpstreamBody(
  req: FastifyRequest,
  limits: { replayBytes: number; maxUploadBytes: number },
): Promise<UpstreamBody> {
  if (req.method === 'GET' || req.method === 'HEAD') return { kind: 'none' };
  if (req.gatewayRawBody) return { kind: 'buffer', bytes: req.gatewayRawBody };
  const raw = req.raw;
  const declared = Number(raw.headers['content-length']);
  const length = Number.isFinite(declared) && declared >= 0 ? declared : null;
  if (length !== null && length > limits.maxUploadBytes) throw new UploadTooLargeError();
  if (length === 0 || (length === null && raw.headers['transfer-encoding'] === undefined)) return { kind: 'none' };

  const iterator = raw[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const head: Buffer[] = [];
  let received = 0;
  if (length === null || length <= limits.replayBytes) {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return { kind: 'buffer', bytes: Buffer.concat(head, received) };
      head.push(next.value);
      received += next.value.length;
      if (received > limits.maxUploadBytes) throw new UploadTooLargeError();
      if (received > limits.replayBytes) break;
    }
  }
  const max = limits.maxUploadBytes;
  async function* rest(): AsyncGenerator<Buffer> {
    let total = received;
    for (const chunk of head) yield chunk;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      total += next.value.length;
      if (total > max) throw new UploadTooLargeError();
      yield next.value;
    }
  }
  return { kind: 'stream', stream: Readable.from(rest(), { objectMode: false }), length };
}
