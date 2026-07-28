/**
 * Pins the one rule that decides what a `versions` row value means. Before
 * `isTruthyFlagValue` existed the kill switches accepted "on" while
 * `SettingsService.getFlag` did not, so a row valued `on` made /v1/* answer 503
 * while the admin state endpoints (which read through getFlag) still reported
 * `disabled: false`. This suite reads the same table of values through all
 * three callers and fails if any of them drifts.
 */
import { describe, expect, it } from 'vitest';
import { SettingsService, isTruthyFlagValue } from '../../../src/services/settings.js';
import { makeOpenAiKillSwitch } from '../../../src/services/openai-kill-switch.js';
import { createClaudeKillSwitch } from '../../../src/services/claude-kill-switch.js';
import type { Database } from '../../../src/db/client.js';

const OPENAI_FLAG = 'openai_api_disabled';
const CLAUDE_FLAG = 'claude_api_disabled';

type Fields = Record<string, { name: string }>;

interface VersionRow {
  name: string;
  version: string | null;
}

/**
 * Minimal `versions` read stub covering both select shapes in play: projected
 * (`getRaw`, the OpenAI switch) and unprojected (the Claude switch).
 */
function versionsDb(rows: VersionRow[]): Database {
  const read = async (fields: Fields | undefined, where: unknown) => {
    const name = whereName(where);
    const matched = rows.filter((row) => row.name === name);
    return fields ? matched.map((row) => project(row, fields)) : matched.map((row) => ({ ...row }));
  };
  return {
    select(fields?: Fields) {
      return {
        from: (_table: unknown) => ({
          where: (condition: unknown) => ({
            limit: (_n: number) => read(fields, condition),
          }),
        }),
      };
    },
  } as unknown as Database;
}

/** Pulls the bound value out of an `eq(versions.name, FLAG)` condition. */
function whereName(condition: unknown): string | undefined {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
  const param = chunks.find(
    (chunk): chunk is { value: unknown } =>
      !!chunk && typeof chunk === 'object' && chunk.constructor?.name === 'Param',
  );
  return typeof param?.value === 'string' ? param.value : undefined;
}

function project(row: VersionRow, fields: Fields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [alias, column] of Object.entries(fields)) {
    out[alias] = (row as unknown as Record<string, unknown>)[column.name];
  }
  return out;
}

/** Every reader of a `versions` flag, fed the same stored value. */
const readers = [
  {
    label: 'SettingsService.getFlag',
    read: (value: string) =>
      new SettingsService(versionsDb([{ name: OPENAI_FLAG, version: value }])).getFlag(OPENAI_FLAG),
  },
  {
    label: 'makeOpenAiKillSwitch',
    read: (value: string) =>
      makeOpenAiKillSwitch(versionsDb([{ name: OPENAI_FLAG, version: value }])).isDisabled(),
  },
  {
    label: 'createClaudeKillSwitch',
    read: (value: string) =>
      createClaudeKillSwitch(versionsDb([{ name: CLAUDE_FLAG, version: value }])).isDisabled(),
  },
];

const VALUES: Array<[value: string, truthy: boolean]> = [
  ['1', true],
  ['true', true],
  ['TRUE', true],
  ['True', true],
  ['yes', true],
  ['YES', true],
  ['on', true],
  ['ON', true],
  [' on ', true],
  ['\tOn\n', true],
  [' 1 ', true],
  ['  yes  ', true],
  ['0', false],
  ['false', false],
  ['FALSE', false],
  ['off', false],
  ['OFF', false],
  ['no', false],
  ['onward', false],
  ['maybe', false],
  ['enabled', false],
  ['', false],
  ['   ', false],
];

describe.each(VALUES)('a versions value of %j', (value, truthy) => {
  it(`is ${truthy ? 'truthy' : 'falsy'} for every reader`, async () => {
    const seen = await Promise.all(
      readers.map(async (reader) => [reader.label, await reader.read(value)] as const),
    );
    expect(Object.fromEntries(seen)).toEqual(
      Object.fromEntries(readers.map((reader) => [reader.label, truthy])),
    );
    expect(isTruthyFlagValue(value)).toBe(truthy);
  });
});

describe('isTruthyFlagValue', () => {
  it('yields the default only for an unset value', () => {
    for (const unset of [null, undefined, '', '   ', '\n\t']) {
      expect(isTruthyFlagValue(unset, true)).toBe(true);
      expect(isTruthyFlagValue(unset)).toBe(false);
    }
    expect(isTruthyFlagValue('0', true)).toBe(false);
    expect(isTruthyFlagValue('on', false)).toBe(true);
  });
});
