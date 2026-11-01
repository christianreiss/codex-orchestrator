/** Config-expressible KeybindingsSpec grammar from rust-v0.166.0
 * codex-rs/config/src/tui_keymap.rs (SHA-256
 * be7f6c274ef9cc5343ac584884c2807d262f3219873753f9e4c825494c85b8cd).
 * Validate without rewriting authored aliases/order. Runtime dispatch/conflicts
 * remain native-owned. Rust split_whitespace uses Unicode White_Space, not JS \s.
 */
import { ValidationError } from '../http/errors.js';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const modifiers: Record<string, string> = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', super: 'super', cmd: 'super', command: 'super' };
const aliases: Record<string, string> = { escape: 'esc', return: 'enter', spacebar: 'space', pgup: 'page-up', pageup: 'page-up', pgdn: 'page-down', pagedown: 'page-down', del: 'delete' };
const namedKeys = new Set(['enter', 'tab', 'backspace', 'esc', 'delete', 'up', 'down', 'left', 'right', 'home', 'end', 'page-up', 'page-down', 'space', 'minus']);
const asciiLower = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase());
const fail = (path: string, message: string): never => { throw new ValidationError(`${path}: ${message}`, { param: path }); };

function stroke(raw: string, path: string): void {
  const segments = asciiLower(raw).split('-').filter(Boolean), seen = new Set<string>(), keys: string[] = [];
  for (const segment of segments) {
    const modifier = Object.hasOwn(modifiers, segment) ? modifiers[segment] : undefined;
    if (modifier && !keys.length) {
      if (seen.has(modifier)) fail(path, 'duplicate keybinding modifier; use each modifier at most once');
      seen.add(modifier);
    } else {
      if (modifier) fail(path, 'keybinding modifiers must precede the key');
      keys.push(segment);
    }
  }
  if (!keys.length) fail(path, 'keybinding requires a key');
  const rawKey = keys.join('-'), key = Object.hasOwn(aliases, rawKey) ? aliases[rawKey]! : rawKey;
  if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126 && key !== '-') return;
  if (namedKeys.has(key)) return;
  // Rust u8::from_str accepts an optional plus and leading zeroes, but no signs
  // other than plus, whitespace, non-ASCII digits or values above 255.
  if (/^f\+?[0-9]+$/.test(key) && Number(key.slice(1)) >= 1 && Number(key.slice(1)) <= 24) return;
  fail(path, 'unknown keybinding key; expected a printable ASCII character, f1–f24 or a supported named key');
}
function binding(raw: string, path: string): void {
  const strokes = raw.split(/\p{White_Space}+/u).filter(Boolean);
  if (!strokes.length) fail(path, 'keybinding cannot be empty; use [] to unbind');
  if (strokes.length > 2) fail(path, 'keybinding chords may contain at most two strokes');
  if (asciiLower(strokes[0]!) === 'leader') {
    if (strokes.length !== 2) fail(path, 'leader must be followed by one key');
    stroke(strokes[1]!, path);
  } else strokes.forEach(value => stroke(value, path));
}

/** Called after schema validation: every context/action leaf is KeybindingsSpec. */
export function validateCodexKeymapSettings(keymap: unknown, path: string): void {
  for (const [context, actions] of Object.entries(record(keymap))) {
    for (const [action, value] of Object.entries(record(actions))) {
      const field = `${path}.${context}.${action}`;
      if (typeof value === 'string') binding(value, field);
      else if (Array.isArray(value)) value.forEach((entry: string, i: number) => binding(entry, `${field}[${i}]`));
    }
  }
}
