import { ApiError } from '../errors.js';
import { isTruthyFlagValue } from '../../services/settings.js';
import { Transform, Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { selectFormatter } from '../envelope/select.js';
import {
  bindOwnerResponseRuntime,
  addOwnerResponseProof,
  finalizeOwnerResponse,
  ownerReadResponseGuard,
  ownerResponseFinalizer,
  type OwnerRuntime,
} from '../../control-plane/state/runtime.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    ownerResponse?: 'committed-action';
  }
}
interface TransportResponse {
  finite?: string | Buffer;
  original?: string | Buffer;
  allowCommitted: boolean;
}
function protectTransport(reply: FastifyReply, runtime: OwnerRuntime, state: TransportResponse): void {
  const raw = reply.raw,
    finish = ownerResponseFinalizer(runtime);
  const writeHead = raw.writeHead,
    write = raw.write,
    end = raw.end;
  let blocked = false;
  const deny = (error: unknown) => {
    if (blocked) return;
    blocked = true;
    if (raw.headersSent) {
      raw.destroy();
      return;
    }
    const failure =
      error instanceof ApiError
        ? error
        : new ApiError('Response authority unavailable', { status: 503, code: 'owner_unavailable' });
    for (const name of raw.getHeaderNames()) raw.removeHeader(name);
    const body = JSON.stringify(selectFormatter(reply.request.url).failure(failure));
    Reflect.apply(writeHead, raw, [
      failure.status,
      { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) },
    ]);
    Reflect.apply(end, raw, [body]);
  };
  const validate = () => {
    if (state.finite !== undefined) {
      const next = finish(state.finite, state.allowCommitted);
      if (typeof next === 'string' || Buffer.isBuffer(next)) state.finite = next;
    } else finish(undefined, false);
  };
  raw.writeHead = function (...args: unknown[]) {
    if (blocked) return raw;
    if (Number(args[0]) < 400) {
      try {
        validate();
        if (
          state.finite !== undefined &&
          Number(args[0]) >= 200 &&
          Number(args[0]) !== 204 &&
          Number(args[0]) !== 304
        ) {
          const length = Buffer.byteLength(state.finite);
          const index = typeof args[1] === 'string' ? 2 : 1;
          const headers = args[index];
          if (Array.isArray(headers)) {
            const replacement = [...headers];
            let found = false;
            for (let i = 0; i < replacement.length; i += 2)
              if (String(replacement[i]).toLowerCase() === 'content-length') {
                replacement[i + 1] = String(length);
                found = true;
              }
            if (!found) replacement.push('content-length', String(length));
            args[index] = replacement;
          } else {
            const replacement = { ...(headers as Record<string, unknown> | undefined) };
            for (const key of Object.keys(replacement))
              if (key.toLowerCase() === 'content-length') delete replacement[key];
            args[index] = { ...replacement, 'content-length': length };
          }
        }
      } catch (error) {
        deny(error);
        return raw;
      }
    }
    return Reflect.apply(writeHead, raw, args);
  } as typeof raw.writeHead;
  raw.write = function (...args: unknown[]) {
    if (blocked) return false;
    if (raw.statusCode < 400) {
      try {
        const before = state.finite;
        validate();
        if (raw.headersSent && state.finite !== before) throw new Error('Response changed after headers');
        if (state.original !== undefined && args[0] === state.original) args[0] = state.finite;
      } catch (error) {
        deny(error);
        return false;
      }
    }
    return Reflect.apply(write, raw, args) as boolean;
  } as typeof raw.write;
  raw.end = function (...args: unknown[]) {
    if (blocked) return raw;
    if (raw.statusCode < 400) {
      try {
        const before = state.finite;
        validate();
        if (raw.headersSent && state.finite !== before) throw new Error('Response changed after headers');
        if (state.original !== undefined && args[0] === state.original) args[0] = state.finite;
      } catch (error) {
        deny(error);
        return raw;
      }
    }
    return Reflect.apply(end, raw, args);
  } as typeof raw.end;
}

/** Run before envelope formatting; raw/binary reads are protected too. */
export function installOwnerResponseBoundary(app: FastifyInstance, runtime: OwnerRuntime): void {
  const transports = new WeakMap<FastifyReply, TransportResponse>();
  app.addHook('onRoute', (route) => {
    const hooks = route.onSend ? (Array.isArray(route.onSend) ? route.onSend : [route.onSend]) : [];
    route.onSend = [
      ...hooks,
      async (_req, reply, payload) => {
        const state = transports.get(reply);
        if (state && (typeof payload === 'string' || Buffer.isBuffer(payload))) {
          state.original = payload;
          state.finite = payload;
        }
        return payload;
      },
    ];
  });
  app.addHook('onRequest', async (req, reply) => {
    bindOwnerResponseRuntime(runtime);
    const transport = { allowCommitted: req.routeOptions.config.ownerResponse === 'committed-action' };
    transports.set(reply, transport);
    protectTransport(reply, runtime, transport);
    if (req.routeOptions.url !== '/admin/api/state')
      addOwnerResponseProof('api-kill-switch', (snapshot) => {
        if (isTruthyFlagValue(snapshot.setting('api_disabled')))
          throw new ApiError('API disabled by administrator', { status: 503, code: 'api_disabled' });
      });
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 400) return payload;
    try {
      const final = finalizeOwnerResponse(
        runtime,
        payload,
        req.routeOptions.config.ownerResponse === 'committed-action',
      );
      if (payload instanceof Readable) {
        const check = ownerReadResponseGuard(runtime),
          guard = new Transform({
            transform(chunk, encoding, done) {
              try {
                check();
                done(null, chunk);
              } catch (error) {
                done(error as Error);
              }
            },
          });
        payload.on('error', (error) => guard.destroy(error));
        guard.on('close', () => payload.destroy());
        return payload.pipe(guard);
      }
      if (typeof final === 'string' && final !== payload)
        reply.header('content-length', Buffer.byteLength(final));
      return final as typeof payload;
    } catch (error) {
      if (payload instanceof Readable) payload.destroy();
      for (const header of [
        'content-length',
        'content-disposition',
        'etag',
        'last-modified',
        'content-range',
        'content-encoding',
        'set-cookie',
      ])
        reply.removeHeader(header);
      throw error;
    }
  });
}
