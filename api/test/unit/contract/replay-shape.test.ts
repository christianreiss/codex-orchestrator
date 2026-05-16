import { describe, it, expect } from 'vitest';
import {
  assertSameShape,
  assertEnvelopeShape,
} from '../../contract/helpers/replay.js';

/**
 * Unit tests for the shape-walker that powers the contract suite. These run
 * without a DB and prove the replay helper catches the regressions we care
 * about while ignoring the noise (ids, timestamps, optional extras).
 */

describe('assertSameShape', () => {
  it('accepts identical objects', () => {
    expect(() => assertSameShape({ a: 1, b: 'x' }, { a: 0, b: '' }, 't')).not.toThrow();
  });

  it('accepts extra keys on actual', () => {
    expect(() =>
      assertSameShape({ a: 1, b: 'x', c: true }, { a: 0, b: '' }, 't'),
    ).not.toThrow();
  });

  it('fails on missing expected key', () => {
    expect(() => assertSameShape({ a: 1 }, { a: 0, b: '' }, 't')).toThrow(/missing keys.*b/);
  });

  it('fails on type mismatch', () => {
    expect(() => assertSameShape({ a: 1 }, { a: 'x' }, 't')).toThrow(/shape mismatch/);
  });

  it('handles arrays homogeneously', () => {
    expect(() =>
      assertSameShape(
        { items: [{ k: 1 }, { k: 2 }, { k: 3 }] },
        { items: [{ k: 0 }] },
        't',
      ),
    ).not.toThrow();
  });

  it('descends nested objects', () => {
    expect(() =>
      assertSameShape(
        { outer: { inner: { x: 1 } } },
        { outer: { inner: { x: 0, y: 'z' } } },
        't',
      ),
    ).toThrow(/inner: missing keys.*y/);
  });

  it('accepts empty arrays in fixture as wildcard', () => {
    expect(() =>
      assertSameShape({ items: [{ a: 1 }, { a: 2 }] }, { items: [] }, 't'),
    ).not.toThrow();
  });
});

describe('assertEnvelopeShape', () => {
  it('standard success requires status:ok', () => {
    expect(() => assertEnvelopeShape({ status: 'ok', data: 1 }, 'standard', 200)).not.toThrow();
    expect(() => assertEnvelopeShape({ ok: 1 }, 'standard', 200)).toThrow();
  });

  it('standard error requires status:error', () => {
    expect(() =>
      assertEnvelopeShape({ status: 'error', message: 'no' }, 'standard', 400),
    ).not.toThrow();
    expect(() => assertEnvelopeShape({ message: 'no' }, 'standard', 400)).toThrow();
  });

  it('openai error requires error.message', () => {
    expect(() =>
      assertEnvelopeShape({ error: { message: 'bad', type: 'invalid_request_error' } }, 'openai', 400),
    ).not.toThrow();
    expect(() => assertEnvelopeShape({ error: 'oops' }, 'openai', 400)).toThrow();
  });

  it('anthropic error requires type:error + error.message', () => {
    expect(() =>
      assertEnvelopeShape(
        { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
        'anthropic',
        400,
      ),
    ).not.toThrow();
    expect(() =>
      assertEnvelopeShape({ error: { message: 'bad' } }, 'anthropic', 400),
    ).toThrow();
  });

  it('raw envelope is a no-op', () => {
    expect(() => assertEnvelopeShape({ anything: true }, 'raw', 200)).not.toThrow();
    expect(() => assertEnvelopeShape({ anything: true }, 'raw', 500)).not.toThrow();
  });
});
