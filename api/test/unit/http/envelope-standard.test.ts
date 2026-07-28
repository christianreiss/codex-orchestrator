import { describe, it, expect } from 'vitest';
import { success, failure } from '../../../src/http/envelope/standard.js';
import { ApiError } from '../../../src/http/errors.js';

/**
 * The standard envelope is the shape contract every Go wrapper struct and the
 * admin client decode against, so its dual root/`data` shaping is load-bearing:
 * `wrappers/cdx/internal/orchestrator/skills.go` hand-guards it by decoding both
 * `skills` and `data.skills`. A silent change here (dropping the root spread,
 * or starting to spread a nested `data` payload at the root) would break wrapper
 * decoding without failing a request-level suite, so pin every branch with
 * whole-object assertions rather than `toMatchObject`.
 */

describe('standard envelope success shaping', () => {
  it('puts object payloads both at the root and under data', () => {
    expect(success({ engine: 'codex', skills: [{ slug: 'a' }] })).toEqual({
      status: 'ok',
      engine: 'codex',
      skills: [{ slug: 'a' }],
      data: { engine: 'codex', skills: [{ slug: 'a' }] },
    });
  });

  it('does not root-spread a payload that already carries its own data key', () => {
    // The nested `skills` stays under `data` only — root-spreading it here would
    // make `data.skills` and `skills` disagree for payloads that carry both.
    expect(success({ data: { skills: [{ slug: 'a' }] } })).toEqual({
      status: 'ok',
      data: { skills: [{ slug: 'a' }] },
    });
    // Sibling keys of `data` keep their root position; only `status` is added.
    expect(success({ data: { skills: [] }, total: 0 })).toEqual({
      status: 'ok',
      data: { skills: [] },
      total: 0,
    });
  });

  it('passes an already-enveloped payload through untouched', () => {
    const enveloped = { status: 'ok', data: { skills: [] }, total: 0 };
    expect(success(enveloped)).toBe(enveloped);
  });

  it('puts array payloads under data only', () => {
    const out = success([1, 2, 3]);
    expect(out).toEqual({ status: 'ok', data: [1, 2, 3] });
    expect(Array.isArray(out)).toBe(false);
  });

  it('puts scalar payloads under data only', () => {
    expect(success('pong')).toEqual({ status: 'ok', data: 'pong' });
    expect(success(42)).toEqual({ status: 'ok', data: 42 });
    expect(success(false)).toEqual({ status: 'ok', data: false });
  });

  it('emits a bare ok envelope for null and undefined', () => {
    expect(success(null)).toEqual({ status: 'ok' });
    expect(success(undefined)).toEqual({ status: 'ok' });
  });
});

describe('standard envelope failure shaping', () => {
  it('copies extra entries to the root and drops undefined ones', () => {
    // RateLimitedError always sets both `bucket` and `reset_at` in `extra`, and
    // leaves them undefined when the limiter has no value — those must not
    // surface as explicit nulls in the JSON body.
    const err = new ApiError('Rate limited', {
      status: 429,
      code: 'rate_limited',
      extra: { bucket: 'chat', reset_at: undefined },
    });
    const out = failure(err);
    expect(out).toEqual({
      status: 'error',
      message: 'Rate limited',
      code: 'rate_limited',
      bucket: 'chat',
    });
    expect('reset_at' in out).toBe(false);
  });

  it('emits status, message and code when there is no extra', () => {
    expect(failure(new ApiError('bad', { status: 400, code: 'bad_request' }))).toEqual({
      status: 'error',
      message: 'bad',
      code: 'bad_request',
    });
  });
});
