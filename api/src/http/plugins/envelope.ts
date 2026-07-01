import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { selectFormatter } from '../envelope/select.js';
import { isOkResult } from '../reply.js';

/**
 * Two responsibilities:
 *   1. `onSend` hook reshapes successful JSON payloads into the right envelope
 *      shape based on the request URL prefix. Handlers that set
 *      reply.envelopeRaw = true (binary, SSE, raw text) are passed through.
 *   2. Global error handler converts ApiError / unknown errors into the same
 *      shape using the envelope dispatcher.
 */
export const envelopePlugin = fp(
  async function envelopePlugin(app: FastifyInstance) {
    app.addHook('onSend', async (request, reply, payload) => {
      if (reply.envelopeRaw) return payload;

      // Streaming / binary / non-JSON content types: pass through
      const ct = reply.getHeader('content-type');
      const isJson = typeof ct === 'string' && ct.includes('application/json');
      if (!isJson && ct !== undefined) return payload;

      // Errors are handled in setErrorHandler; envelope wraps successful payloads.
      if (reply.statusCode >= 400) return payload;

      let data: unknown;
      if (typeof payload === 'string') {
        try {
          data = JSON.parse(payload);
        } catch {
          return payload; // not JSON, leave alone
        }
      } else if (payload && typeof payload === 'object' && !(payload instanceof Buffer)) {
        data = payload;
      } else {
        return payload;
      }

      // Unwrap ok(data) results
      if (isOkResult(data)) data = data.data;

      const formatter = selectFormatter(request.url);
      const shaped = formatter.success(data ?? null);
      reply.header('content-type', 'application/json; charset=utf-8');
      const serialized = JSON.stringify(shaped);
      reply.header('content-length', Buffer.byteLength(serialized));
      return serialized;
    });

    app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
      const apiErr = toApiError(err);
      if (apiErr.status >= 500) {
        request.log.error({ err }, apiErr.message);
      } else {
        request.log.warn({ err: { code: apiErr.code, message: apiErr.message } }, 'request error');
      }

      if (apiErr.headers) {
        for (const [k, v] of Object.entries(apiErr.headers)) reply.header(k, v);
      }

      const formatter = selectFormatter(request.url);
      reply.envelopeRaw = true; // we render the final body here
      reply
        .status(apiErr.status)
        .header('content-type', 'application/json; charset=utf-8')
        .send(JSON.stringify(formatter.failure(apiErr)));
    });

    // Not-found is intentionally left to the route layer (routes/index.ts wires
    // the SPA fallback under /admin/* and a default JSON 404 elsewhere). That
    // keeps the static plugin and the envelope plugin from fighting over which
    // 404 wins.
  },
  { name: 'envelope' },
);

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (
    err &&
    typeof err === 'object' &&
    'statusCode' in err &&
    typeof (err as { statusCode: number }).statusCode === 'number'
  ) {
    const fe = err as { statusCode: number; message?: string; code?: string };
    const status = fe.statusCode;
    if (status === 400) {
      return new ApiError(fe.message ?? 'Bad request', { status, code: fe.code ?? 'bad_request' });
    }
    if (status === 401) return new ApiError(fe.message ?? 'Unauthorized', { status, code: 'unauthorized' });
    if (status === 404) return new ApiError(fe.message ?? 'Not found', { status, code: 'not_found' });
    if (status === 415) return new ApiError(fe.message ?? 'Unsupported media type', { status, code: 'unsupported_media_type' });
    if (status >= 500) return new ApiError('Internal server error', { status, code: fe.code ?? 'server_error' });
    return new ApiError(fe.message ?? 'Error', { status });
  }
  return new ApiError('Internal server error', { status: 500, code: 'server_error' });
}
