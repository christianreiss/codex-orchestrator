import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `ADMIN_THEMES` in the settings route is the sole validator for POST
 * /admin/theme, and five frontend files re-spell the same six values: the
 * `AccountTheme` union the picker sends, the `Preset`/`BaseTheme` unions the
 * theme page offers, the `ThemePalette` union and storage keys of the theme
 * store, the inline palette allowlist of the FOUC script in app.html and the
 * `[data-theme]` blocks in app.css. Drift is silent in both directions: a
 * palette the frontend gains but the server does not makes the picker 400 on
 * save, and one dropped from app.css or the app.html list yields an option that
 * renders nothing or flashes the previous colours on every reload.
 *
 * All six files are parsed as text — the frontend ones sit outside the api
 * tsconfig, and the route pulls in the db and most of the service layer for the
 * sake of one const. Membership only, never order: order is the picker's
 * business, and the server's list interleaves the pink presets on purpose.
 */

const SETTINGS_FILE = 'api/src/routes/admin/settings/index.ts';
const ACCOUNT_FILE = 'frontend/src/lib/api/account.ts';
const STORE_FILE = 'frontend/src/lib/stores/theme.ts';
const HTML_FILE = 'frontend/src/app.html';
const CSS_FILE = 'frontend/src/app.css';
const PAGE_FILE = 'frontend/src/routes/account/theme/+page.svelte';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * Themes one surface carries on purpose without another, keyed
 * `<comparison>.<theme>` with the reason. Empty today — every list agrees. An
 * entry belongs here only for a deliberate delta, e.g. a value POST /admin/theme
 * still accepts so already-persisted accounts keep working but the picker no
 * longer offers.
 */
const DELIBERATE_DELTAS: Record<string, string> = {};

/** Blank out whole-line comments, keeping every other character at its offset. */
const blankComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');

const read = (file: string): string => blankComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));

const settingsSource = read(SETTINGS_FILE);
const accountSource = read(ACCOUNT_FILE);
const storeSource = read(STORE_FILE);
const htmlSource = read(HTML_FILE);
const cssSource = read(CSS_FILE);
const pageSource = read(PAGE_FILE);

const STRING_LITERAL = /(?:'([^']*)'|"([^"]*)")/g;

/** Every string literal of a fragment, i.e. the members of a list or a union. */
const literals = (text: string): string[] =>
  [...text.matchAll(STRING_LITERAL)].map((literal) => literal[1] ?? literal[2]!);

/**
 * Body of the array literal `const <name>` is assigned. Brackets are counted
 * without regard for quotes, which is enough: no theme id carries one.
 */
const arrayBody = (source: string, file: string, name: string): string => {
  const declaration = new RegExp(`\\bconst ${name}\\b[^=]*=\\s*\\[`).exec(source);
  if (!declaration) throw new Error(`${name} array not found in ${file}`);
  const open = declaration.index + declaration[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unterminated ${name} array in ${file}`);
};

/** Members of the string-literal union `type <name>`, up to its terminating `;`. */
const unionMembers = (source: string, file: string, name: string): string[] => {
  const declaration = new RegExp(`\\btype ${name}\\b\\s*=`).exec(source);
  if (!declaration) throw new Error(`type ${name} not found in ${file}`);
  const end = source.indexOf(';', declaration.index);
  if (end === -1) throw new Error(`unterminated type ${name} in ${file}`);
  return literals(source.slice(declaration.index + declaration[0].length, end));
};

/** Literal of a top-level string const, i.e. one of the storage keys. */
const stringConst = (source: string, file: string, name: string): string => {
  const pattern = new RegExp(`\\bconst ${name}\\b[^=]*=\\s*(?:'([^']*)'|"([^"]*)")`);
  const declaration = pattern.exec(source);
  if (!declaration) throw new Error(`${name} string const not found in ${file}`);
  return declaration[1] ?? declaration[2]!;
};

const INCLUDES_ARRAY = /\[([^\]]*)\]\s*\.includes\s*\(/g;
const GET_ITEM_KEY = /localStorage\.getItem\(\s*(?:'([^']*)'|"([^"]*)")/g;
const DATA_THEME = /\[data-theme\s*=\s*"([^"]*)"\]/g;

/** The palette allowlist the FOUC script tests the stored value against. */
const htmlPalettes = (): string[] => {
  const arrays = [...htmlSource.matchAll(INCLUDES_ARRAY)];
  if (arrays.length !== 1) {
    throw new Error(`expected one palette allowlist array in ${HTML_FILE}, found ${arrays.length}`);
  }
  return literals(arrays[0]![1]!);
};

const unique = (values: string[]): string[] => [...new Set(values)];

const ADMIN_THEMES = literals(arrayBody(settingsSource, SETTINGS_FILE, 'ADMIN_THEMES'));
const ACCOUNT_THEMES = unionMembers(accountSource, ACCOUNT_FILE, 'AccountTheme');
const PAGE_THEMES = unique([
  ...unionMembers(pageSource, PAGE_FILE, 'Preset'),
  ...unionMembers(pageSource, PAGE_FILE, 'BaseTheme'),
]);
const PALETTES = unionMembers(storeSource, STORE_FILE, 'ThemePalette');
const HTML_PALETTES = htmlPalettes();
const CSS_THEMES = unique([...cssSource.matchAll(DATA_THEME)].map((selector) => selector[1]!));
const HTML_STORAGE_KEYS = [...htmlSource.matchAll(GET_ITEM_KEY)].map((key) => key[1] ?? key[2]!);
const STORAGE_KEY = stringConst(storeSource, STORE_FILE, 'STORAGE_KEY');
const PALETTE_STORAGE_KEY = stringConst(storeSource, STORE_FILE, 'PALETTE_STORAGE_KEY');

interface Comparison {
  /** Key prefix in DELIBERATE_DELTAS. */
  id: string;
  /** The list under test, and where it is spelled. */
  actual: { where: string; values: readonly string[] };
  /** The list it must agree with. */
  expected: { where: string; values: readonly string[] };
  /** Also flag values the expected side has and the actual side lacks. */
  bothWays: boolean;
  /** What breaks when this drifts, appended to the failure message. */
  consequence: string;
}

const COMPARISONS: Comparison[] = [
  {
    id: 'AccountTheme',
    actual: { where: `AccountTheme (${ACCOUNT_FILE})`, values: ACCOUNT_THEMES },
    expected: { where: `ADMIN_THEMES (${SETTINGS_FILE})`, values: ADMIN_THEMES },
    bothWays: true,
    consequence: 'the union types every call into POST /admin/theme, which accepts nothing else',
  },
  {
    id: 'ThemePage',
    actual: { where: `Preset|BaseTheme (${PAGE_FILE})`, values: PAGE_THEMES },
    expected: { where: `ADMIN_THEMES (${SETTINGS_FILE})`, values: ADMIN_THEMES },
    bothWays: true,
    consequence: 'the page offers one radio per member, so a value it omits cannot be chosen back',
  },
  {
    id: 'PaletteAdmin',
    actual: { where: `ThemePalette (${STORE_FILE})`, values: PALETTES },
    expected: { where: `ADMIN_THEMES (${SETTINGS_FILE})`, values: ADMIN_THEMES },
    bothWays: false,
    consequence: 'a palette the server rejects is one the picker 400s on when saving',
  },
  {
    id: 'PaletteHtml',
    actual: { where: `ThemePalette (${STORE_FILE})`, values: PALETTES },
    expected: { where: `the FOUC palette list (${HTML_FILE})`, values: HTML_PALETTES },
    bothWays: false,
    consequence: 'a palette the FOUC script drops flashes the default colours on every reload',
  },
  {
    id: 'PaletteCss',
    actual: { where: `ThemePalette (${STORE_FILE})`, values: PALETTES },
    expected: { where: `the [data-theme] blocks (${CSS_FILE})`, values: CSS_THEMES },
    bothWays: false,
    consequence: 'a palette without a rule block sets an attribute that restyles nothing',
  },
];

/** Every disagreement of a comparison, before the allowlist is applied. */
const drift = ({ actual, expected, bothWays }: Comparison): { value: string; message: string }[] => [
  ...actual.values
    .filter((value) => !expected.values.includes(value))
    .map((value) => ({ value, message: `${actual.where} has "${value}", ${expected.where} does not` })),
  ...(bothWays
    ? expected.values
        .filter((value) => !actual.values.includes(value))
        .map((value) => ({ value, message: `${expected.where} has "${value}", ${actual.where} does not` }))
    : []),
];

const undeclaredDrift = (comparison: Comparison): string[] =>
  drift(comparison)
    .filter(({ value }) => !(`${comparison.id}.${value}` in DELIBERATE_DELTAS))
    .map(({ message }) => message);

const hint = (comparison: Comparison): string =>
  `${comparison.consequence} — align the lists, or record the delta in DELIBERATE_DELTAS here ` +
  `with a reason (allowlist key "${comparison.id}.<theme>")`;

describe('frontend theme catalog', () => {
  it('extracts the theme lists it is meant to compare', () => {
    // A parser reading nothing — after a rename of a file, a const or a type —
    // would pass every comparison below vacuously.
    expect(ADMIN_THEMES, SETTINGS_FILE).toContain('dark-pink');
    expect(ACCOUNT_THEMES, ACCOUNT_FILE).toContain('auto');
    expect(PAGE_THEMES, PAGE_FILE).toContain('bright-pink');
    expect(PALETTES, STORE_FILE).toContain('auto-pink');
    expect(HTML_PALETTES, HTML_FILE).toContain('auto-pink');
    expect(CSS_THEMES, CSS_FILE).toContain('dark-pink');
    expect(HTML_STORAGE_KEYS, HTML_FILE).not.toEqual([]);
    expect(STORAGE_KEY, STORE_FILE).toBe('codex.theme');
    expect(PALETTE_STORAGE_KEY, STORE_FILE).toBe('codex.theme.palette');
  });

  it('offers exactly the themes POST /admin/theme accepts', () => {
    for (const comparison of COMPARISONS.filter(({ bothWays }) => bothWays)) {
      expect(undeclaredDrift(comparison), hint(comparison)).toEqual([]);
    }
  });

  it('persists and renders every palette the store can set', () => {
    for (const comparison of COMPARISONS.filter(({ bothWays }) => !bothWays)) {
      expect(undeclaredDrift(comparison), hint(comparison)).toEqual([]);
    }
  });

  it('reads the storage keys the FOUC script writes them under', () => {
    for (const key of [STORAGE_KEY, PALETTE_STORAGE_KEY]) {
      expect(
        HTML_STORAGE_KEYS,
        `${STORE_FILE} persists under "${key}", which the inline script in ${HTML_FILE} never ` +
          'reads — the theme applies only once the store hydrates, i.e. after the FOUC',
      ).toContain(key);
    }
  });

  it('keeps the allowlist to deltas that still exist', () => {
    const stale = Object.keys(DELIBERATE_DELTAS).filter((entry) => {
      const comparison = COMPARISONS.find(({ id }) => entry.startsWith(`${id}.`));
      if (!comparison) return true;
      // Comparison ids carry no dot, so the first one splits off the theme.
      const value = entry.slice(entry.indexOf('.') + 1);
      return !drift(comparison).some((disagreement) => disagreement.value === value);
    });
    expect(stale, 'drop the allowlist entry: the theme is gone or both sides agree on it').toEqual([]);
  });
});
