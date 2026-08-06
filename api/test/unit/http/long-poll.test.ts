import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { clientGone } from '../../../src/http/long-poll.js';

/**
 * The bug this pins was invisible to every other test in the tree, because it
 * only exists over a real socket: `app.inject()` never produces the stream
 * lifecycle that made it happen, and no suite asserted how long a long poll
 * waits, only what it returned.
 *
 * `req.raw.destroyed` reads as the obvious "did the client go away" check and is
 * not one. `IncomingMessage` is a readable, Fastify has fully consumed it before
 * the handler runs, and Node auto-destroys an ended readable — so it flips true
 * on a healthy connection within milliseconds. Four long polls guarded on it and
 * every one of them returned empty on its first pass: `cxx portal wait
 * --seconds 20` answered in 0.1 s against live crane on 2026-08-06, which turned
 * the `#afk` relay loop into a spin of model turns.
 */
describe('clientGone', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  /** Samples the signal across a handler that outlives the request body. */
  const serve = async (): Promise<{ url: string; samples: () => boolean[] }> => {
    const collected: boolean[] = [];
    app = Fastify();
    app.post('/poll', async (req, reply) => {
      for (let i = 0; i < 12; i++) {
        collected.push(clientGone(reply));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return { url: `http://127.0.0.1:${address.port}/poll`, samples: () => collected };
  };

  const body = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' } as const;

  it('stays false for the whole life of a healthy request that has a body', async () => {
    const { url, samples } = await serve();
    const response = await fetch(url, body);
    expect(response.status).toBe(200);
    // Not `some`: the point is that it never flips, and it used to flip on the
    // second sample while the client was still waiting for its answer.
    expect(samples()).toHaveLength(12);
    expect(samples().every((sample) => sample === false)).toBe(true);
  });

  it('flips to true once the client actually disconnects', async () => {
    const { url, samples } = await serve();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120);
    await fetch(url, { ...body, signal: controller.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(samples().at(0)).toBe(false);
    expect(samples().at(-1)).toBe(true);
  });

  /**
   * The four sites that had this wrong all read naturally, which is why the same
   * mistake was made four times. Nothing about `req.raw.destroyed` is unsafe on
   * its own — it is only ever wrong as a client-gone check — so the guard is
   * scoped to the route tree, where that is the only reason to reach for it.
   */
  it('is the only client-gone check used by the route tree', () => {
    const routes = join(dirname(fileURLToPath(import.meta.url)), '../../../src/routes');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith('.ts') && /\breq(uest)?\.raw\.destroyed\b/.test(readFileSync(path, 'utf8'))) {
          offenders.push(path);
        }
      }
    };
    walk(routes);
    expect(offenders).toEqual([]);
  });
});
