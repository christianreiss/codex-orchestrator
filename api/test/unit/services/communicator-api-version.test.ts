import { describe, expect, it } from 'vitest';
import {
  ApiLevelTracker,
  COMMUNICATOR_API_VERSION,
  COMMUNICATOR_MIN_API,
  communicatorApiLevels,
  observeRequestApiLevel,
  apiLevelTracker,
  parseClientApiLevel,
  parseStoredMinApi,
  readCommunicatorApiLevels,
  tallyApiLevels,
  validateMinApiInput,
} from '../../../src/services/communicator-api-version.js';

describe('communicator API level constants', () => {
  it('start at 1 and never invert', () => {
    expect(COMMUNICATOR_API_VERSION).toBe(1);
    expect(COMMUNICATOR_MIN_API).toBe(1);
    expect(COMMUNICATOR_MIN_API).toBeLessThanOrEqual(COMMUNICATOR_API_VERSION);
  });
});

describe('communicatorApiLevels', () => {
  it('uses the code default when nothing is stored', () => {
    expect(communicatorApiLevels(null)).toEqual({ api_version: 1, min_api: 1 });
    expect(communicatorApiLevels(undefined)).toEqual({ api_version: 1, min_api: 1 });
  });
  it('takes max(code default, stored override)', () => {
    expect(communicatorApiLevels('3', 5, 2)).toEqual({ api_version: 5, min_api: 3 });
    expect(communicatorApiLevels('1', 5, 2)).toEqual({ api_version: 5, min_api: 2 });
    expect(communicatorApiLevels(null, 5, 2)).toEqual({ api_version: 5, min_api: 2 });
  });
  it('never lets the minimum exceed the current level', () => {
    expect(communicatorApiLevels('9', 5, 2)).toEqual({ api_version: 5, min_api: 5 });
    expect(communicatorApiLevels('999999999', 1)).toEqual({ api_version: 1, min_api: 1 });
  });
  it.each(['', ' ', 'abc', '-1', '0', '1.5', '1e3', '0x10', '12345678901'])(
    'ignores unusable stored value %j',
    (raw) => {
      expect(parseStoredMinApi(raw)).toBeNull();
      expect(communicatorApiLevels(raw, 5, 2)).toEqual({ api_version: 5, min_api: 2 });
    },
  );
  it('reads through anything with getRaw', async () => {
    expect(await readCommunicatorApiLevels({ getRaw: async () => '7' })).toEqual({ api_version: 1, min_api: 1 });
    expect(await readCommunicatorApiLevels({ getRaw: async () => null })).toEqual({ api_version: 1, min_api: 1 });
  });
});

describe('validateMinApiInput', () => {
  it('accepts integers inside [default, current]', () => {
    expect(validateMinApiInput(1)).toBe(1);
    expect(validateMinApiInput('1')).toBe(1);
    expect(validateMinApiInput(3, 5, 2)).toBe(3);
    expect(validateMinApiInput('5', 5, 2)).toBe(5);
    expect(validateMinApiInput(2, 5, 2)).toBe(2);
  });
  it.each([0, -1, 2, 1.5, NaN, Infinity, null, undefined, true, '1.5', 'x', '', {}, [1]])(
    'rejects %j at the default levels',
    (value) => {
      expect(() => validateMinApiInput(value)).toThrow(RangeError);
    },
  );
  it('rejects above current and below the code default', () => {
    expect(() => validateMinApiInput(6, 5, 2)).toThrow(/between 2 and 5/);
    expect(() => validateMinApiInput(1, 5, 2)).toThrow(/between 2 and 5/);
  });
});

describe('parseClientApiLevel', () => {
  it.each([
    [1, 1],
    ['1', 1],
    [' 12 ', 12],
    [1_000_000, 1_000_000],
    [['3', '4'], 3],
  ])('parses %j', (value, expected) => {
    expect(parseClientApiLevel(value)).toBe(expected);
  });
  it.each([0, -1, 1.5, NaN, 1_000_001, '0', '-1', '1.5', 'abc', '', '99999999', null, undefined, {}, true, []])(
    'treats %j as unstated',
    (value) => {
      expect(parseClientApiLevel(value)).toBeNull();
    },
  );
});

describe('tallyApiLevels', () => {
  it('classifies against the minimum and the current level', () => {
    const counts = tallyApiLevels([1, 2, 3, 4, 5, 6, null, undefined], { api_version: 5, min_api: 3 });
    expect(counts).toEqual({ observed: 8, below_min: 2, below_current: 4, at_current: 2, unreported: 2 });
  });
  it('is all zeros for nothing observed', () => {
    expect(tallyApiLevels([], { api_version: 1, min_api: 1 })).toEqual({
      observed: 0,
      below_min: 0,
      below_current: 0,
      at_current: 0,
      unreported: 0,
    });
  });
});

describe('ApiLevelTracker', () => {
  const HOUR = 3_600_000;
  function clocked(windowMs = 6 * HOUR) {
    let now = 1_000_000;
    const tracker = new ApiLevelTracker(windowMs, 50_000, () => now);
    return { tracker, advance: (ms: number) => (now += ms) };
  }

  it('reports the lowest level a host stated inside the window', () => {
    const { tracker } = clocked();
    tracker.observe(1, 3);
    tracker.observe(1, 2);
    tracker.observe(1, null);
    expect(tracker.levelOf(1)).toBe(2);
    expect(tracker.levelOf(404)).toBeNull();
  });

  it('forgets a stale level once the binary that stated it stops calling', () => {
    const { tracker, advance } = clocked();
    tracker.observe(1, 1);
    advance(5 * HOUR);
    tracker.observe(1, 2);
    expect(tracker.levelOf(1)).toBe(1);
    advance(2 * HOUR);
    tracker.observe(1, 2);
    expect(tracker.levelOf(1)).toBe(2);
  });

  it('expires hosts that stop calling', () => {
    const { tracker, advance } = clocked();
    tracker.observe(1, 2);
    advance(7 * HOUR);
    expect(tracker.counts({ api_version: 2, min_api: 1 }).observed).toBe(0);
    expect(tracker.entries()).toEqual([]);
  });

  it('counts hosts below the minimum, below current, at current and unreported', () => {
    const { tracker } = clocked();
    tracker.observe(1, 1);
    tracker.observe(2, 3);
    tracker.observe(3, 5);
    tracker.observe(4, null);
    expect(tracker.counts({ api_version: 5, min_api: 2 })).toEqual({
      observed: 4,
      below_min: 1,
      below_current: 2,
      at_current: 1,
      unreported: 1,
    });
  });

  it('stays bounded in hosts and in levels per host', () => {
    const tracker = new ApiLevelTracker(HOUR, 3, () => 0);
    for (let id = 1; id <= 10; id++) tracker.observe(id, 1);
    expect(tracker.entries()).toHaveLength(3);
    for (let level = 1; level <= 20; level++) tracker.observe(1, level);
    expect(tracker.levelOf(1)).toBe(1);
  });

  it('forget removes a host', () => {
    const { tracker } = clocked();
    tracker.observe(1, 2);
    tracker.forget(1);
    expect(tracker.levelOf(1)).toBeNull();
  });
});

describe('observeRequestApiLevel', () => {
  it('feeds the shared tracker from a header and ignores anonymous requests', () => {
    apiLevelTracker.clear();
    observeRequestApiLevel(undefined, { 'x-cxx-api': '1' });
    expect(apiLevelTracker.entries()).toEqual([]);
    observeRequestApiLevel(77, { 'x-cxx-api': '1' });
    observeRequestApiLevel(78, {});
    observeRequestApiLevel(79, { 'x-cxx-api': 'nope' });
    expect(apiLevelTracker.levelOf(77)).toBe(1);
    expect(apiLevelTracker.levelOf(78)).toBeNull();
    expect(apiLevelTracker.levelOf(79)).toBeNull();
    expect(apiLevelTracker.entries().map((e) => e.host_id).sort()).toEqual([77, 78, 79]);
    apiLevelTracker.clear();
  });
});
