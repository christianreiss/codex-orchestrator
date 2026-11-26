import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The exact request bytes of a JSON or text/plain body on a gateway
     * surface. The emulated backends read the parsed `req.body`; the upstream
     * forward sends these bytes unchanged, so a client's payload reaches the
     * provider 1:1 and can be replayed to the next key on failover.
     */
    gatewayRawBody?: Buffer;
  }
}

/**
 * Replace the gateway scope's `application/json` and `text/plain` parsers with
 * buffer parsers that keep the raw bytes and then hand them to Fastify's own
 * default parsers. Fastify reads every body as Buffer chunks and decodes it
 * once with `toString('utf8')` before calling a string parser, and an added
 * parser inherits the instance body limit, so content-type matching, the
 * size limit, empty-body and invalid-JSON errors and prototype-poisoning
 * handling stay exactly what the root scope does.
 *
 * Call it on an encapsulated scope (`app.register`), never on the root: the
 * admin API must keep the default parsers.
 */
export function installGatewayBodyCapture(scope: FastifyInstance): void {
  const json = scope.getDefaultJsonParser(
    scope.initialConfig.onProtoPoisoning ?? 'error',
    scope.initialConfig.onConstructorPoisoning ?? 'error',
  );
  scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const raw = body as Buffer;
    req.gatewayRawBody = raw;
    json(req, raw.toString('utf8'), done);
  });
  scope.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (req, body, done) => {
    const raw = body as Buffer;
    req.gatewayRawBody = raw;
    done(null, raw.toString('utf8'));
  });
}
