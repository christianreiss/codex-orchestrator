import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `/admin/theme` retains its historic values so persisted preferences remain
 * valid. The console itself deliberately offers only the neutral System,
 * Light, and Dark choices, mapping legacy values before rendering. This test
 * protects both sides of that boundary without requiring a visual picker to
 * continue exposing retired pink palettes.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const SETTINGS_FILE = 'api/src/routes/admin/settings/index.ts';
const ACCOUNT_FILE = 'frontend/src/lib/api/account.ts';
const STORE_FILE = 'frontend/src/lib/stores/theme.ts';
const HTML_FILE = 'frontend/src/app.html';
const CSS_FILE = 'frontend/src/app.css';
const PAGE_FILE = 'frontend/src/routes/account/theme/+page.svelte';

const read = (file: string): string => readFileSync(resolve(REPO_ROOT, file), 'utf8');
const STRING_LITERAL = /(?:'([^']*)'|"([^"]*)")/g;
const literals = (text: string): string[] =>
  [...text.matchAll(STRING_LITERAL)].map((literal) => literal[1] ?? literal[2]!);

function arrayBody(source: string, file: string, name: string): string {
  const declaration = new RegExp(`\\bconst ${name}\\b[^=]*=\\s*\\[`).exec(source);
  if (!declaration) throw new Error(`${name} array not found in ${file}`);
  const open = declaration.index + declaration[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unterminated ${name} array in ${file}`);
}

function unionMembers(source: string, file: string, name: string): string[] {
  const declaration = new RegExp(`\\btype ${name}\\b\\s*=`).exec(source);
  if (!declaration) throw new Error(`type ${name} not found in ${file}`);
  const end = source.indexOf(';', declaration.index);
  if (end === -1) throw new Error(`unterminated type ${name} in ${file}`);
  return literals(source.slice(declaration.index + declaration[0].length, end));
}

const settings = read(SETTINGS_FILE);
const account = read(ACCOUNT_FILE);
const store = read(STORE_FILE);
const html = read(HTML_FILE);
const css = read(CSS_FILE);
const page = read(PAGE_FILE);

const serverThemes = literals(arrayBody(settings, SETTINGS_FILE, 'ADMIN_THEMES'));
const accountThemes = unionMembers(account, ACCOUNT_FILE, 'AccountTheme');
const localThemes = unionMembers(store, STORE_FILE, 'ThemeChoice');
const legacyThemes = unionMembers(store, STORE_FILE, 'LegacyThemeChoice');
const pickerThemes = [...page.matchAll(/value:\s*"([^"]+)"/g)].map((match) => match[1]!);

describe('frontend theme catalog', () => {
  it('keeps every value the server accepts in the wire-format type', () => {
    expect(serverThemes).toEqual(['auto', 'auto-pink', 'light', 'dark', 'bright-pink', 'dark-pink']);
    expect([...accountThemes].sort()).toEqual([...serverThemes].sort());
  });

  it('offers and renders one neutral family only', () => {
    expect(localThemes).toEqual(['light', 'dark', 'system']);
    expect(pickerThemes).toEqual(['system', 'light', 'dark']);
    expect(css).not.toMatch(/\[data-theme/);
    expect(css).not.toMatch(/pink|Source Serif/);
  });

  it('migrates historic values instead of re-offering them', () => {
    expect(legacyThemes).toEqual(['auto-pink', 'bright-pink', 'dark-pink']);
    expect(store).toContain('if (value === "auto" || value === "auto-pink") return "system";');
    expect(store).toContain('if (value === "bright-pink") return "light";');
    expect(store).toContain('if (value === "dark-pink") return "dark";');
    expect(page).toContain('value === "system" ? "auto" : value');
    expect(html).toContain('raw === "auto" || raw === "auto-pink"');
  });
});
