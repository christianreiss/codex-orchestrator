import type { FastifyReply, FastifyRequest } from 'fastify';
import { selectFormatter } from './envelope/select.js';
import { ApiError } from './errors.js';

/**
 * The JSON 404 body. Both not-found handlers (`routes/index.ts` when there is
 * no static root, `admin/pages/static.ts` once the SPA HTML branch declines)
 * and the test harness serve this one, so an unmatched /v1/* path fails in the
 * OpenAI shape and /anthropic/v1/* in the Anthropic shape everywhere. The
 * handler renders the final body itself, hence `envelopeRaw`.
 */
export function notFoundHandler(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const formatter = selectFormatter(req.url);
  const err = new ApiError('Route not found', {
    status: 404,
    code: 'not_found',
    type: 'not_found_error',
  });
  reply.envelopeRaw = true;
  reply.status(404).header('content-type', 'application/json; charset=utf-8');
  return reply.send(JSON.stringify(formatter.failure(err)));
}
