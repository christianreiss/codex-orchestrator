import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunnerOpenAiAdapter } from '../../../src/services/adapters/runner-openai.js';
import { createRunnerClaudeAdapter } from '../../../src/services/adapters/runner-claude.js';
import type { Engine } from '../../../src/util/engine.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function adapter(wire: 'openai' | 'anthropic', engine: Engine, auth = vi.fn(async () => ({}))) {
  const success = vi.fn();
  const invoke = wire === 'openai'
    ? (() => {
      const instance = new RunnerOpenAiAdapter({
        execUrl: 'http://runner/exec', sharedSecret: 'test', timeoutSeconds: 1,
        engine, authSnapshot: auth, onExecSuccess: success,
      });
      return (signal?: AbortSignal) => instance.chatCompletions([{ role: 'user', content: 'hi' }], 'test', {}, signal);
    })()
    : (() => {
      const instance = createRunnerClaudeAdapter({
        env: { AUTH_RUNNER_URL: 'http://runner/exec', AUTH_RUNNER_EXEC_TIMEOUT: 1, AUTH_RUNNER_SHARED_SECRET: 'test' } as never,
        engine, getAuthSnapshot: auth, onExecSuccess: success,
      })!;
      return (signal?: AbortSignal) => instance.messages([{ role: 'user', content: 'hi' }], 'test', {}, signal);
    })();
  return { invoke, auth, success };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

for (const wire of ['openai', 'anthropic'] as const) {
  for (const engine of ['codex', 'claude', 'grok'] as const) {
    describe(`${wire} adapter cancellation on ${engine}`, () => {
      it('refuses an already cancelled call without reading credentials or executing', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const { invoke, auth, success } = adapter(wire, engine);
        const controller = new AbortController();
        const reason = new Error('caller disconnected');
        controller.abort(reason);
        await expect(invoke(controller.signal)).rejects.toBe(reason);
        expect(auth).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();
      });

      it('does not launch after cancellation while credentials are loading', async () => {
        const credentials = deferred<Record<string, unknown>>();
        const auth = vi.fn(() => credentials.promise);
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const { invoke, success } = adapter(wire, engine, auth);
        const controller = new AbortController();
        const reason = new Error('caller disconnected');
        const result = invoke(controller.signal);
        controller.abort(reason);
        credentials.resolve({});
        await expect(result).rejects.toBe(reason);
        expect(fetcher).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();
      });

      it('aborts an in-flight runner fetch and does not verify its credentials', async () => {
        const started = deferred<AbortSignal>();
        vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          started.resolve(signal);
        })));
        const { invoke, success } = adapter(wire, engine);
        const controller = new AbortController();
        const reason = new Error('caller disconnected');
        const result = invoke(controller.signal);
        const signal = await started.promise;
        controller.abort(reason);
        await expect(result).rejects.toBe(reason);
        expect(signal.aborted).toBe(true);
        expect(success).not.toHaveBeenCalled();
      });

      it('rejects a late success from a transport that ignores cancellation', async () => {
        const started = deferred<void>();
        const response = deferred<Response>();
        vi.stubGlobal('fetch', vi.fn(() => { started.resolve(); return response.promise; }));
        const { invoke, success } = adapter(wire, engine);
        const controller = new AbortController();
        const reason = new Error('caller disconnected');
        const result = invoke(controller.signal);
        await started.promise;
        controller.abort(reason);
        response.resolve(new Response(JSON.stringify({ status: 'ok', output: 'too late' })));
        await expect(result).rejects.toBe(reason);
        expect(success).not.toHaveBeenCalled();
      });

      it('keeps the deadline active while reading the runner JSON body', async () => {
        vi.useFakeTimers();
        const reading = deferred<void>();
        vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => ({
          json: () => new Promise((_resolve, reject) => {
            const signal = init.signal!;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            reading.resolve();
          }),
        }) as Response));
        const { invoke, success } = adapter(wire, engine);
        const result = invoke();
        const rejected = expect(result).rejects.toMatchObject({ status: 504, code: 'runner_timeout' });
        await reading.promise;
        await vi.advanceTimersByTimeAsync(6000);
        await rejected;
        expect(success).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      });
    });
  }
}
