import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the six real, reachable admin-UI theme states from app.css and
 * asserts WCAG contrast ratios on every pairing an operator actually reads.
 *
 * "Reachable" matters: :root[data-theme="dark-pink"] alone (no .dark class)
 * is valid CSS but never happens in the app — onChoosePreset() in
 * lib/stores/theme.ts always pairs a preset with its forced base mode. This
 * test only checks combinations the app can actually produce, and applies
 * selector blocks in the same precedence the real cascade uses, so a token
 * added to :root/.dark but forgotten in a pink block is caught by the pink
 * theme silently inheriting the wrong value, not by a false alarm here.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const APP_CSS = resolve(ROOT, "frontend/src/app.css");
const css = readFileSync(APP_CSS, "utf8");

type Tokens = Record<string, string>;

/** Extracts `--name: value;` pairs from the first `{...}` block following `anchor`. */
function block(source: string, anchor: string): Tokens {
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error(`selector not found in app.css: ${anchor}`);
  const braceOpen = source.indexOf("{", start);
  const braceClose = source.indexOf("}", braceOpen);
  const body = source.slice(braceOpen + 1, braceClose);
  const tokens: Tokens = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

// Named blocks, matched against the exact selectors written in app.css.
const ROOT_LIGHT = block(css, ":root {");
const DARK = block(css, ".dark {");
const PINK_SHARED_LIGHT = block(css, ':root[data-theme="auto-pink"],\n:root[data-theme="bright-pink"] {');
const PINK_AUTO_DARK = block(css, ':root.dark[data-theme="auto-pink"] {');
const PINK_DARK = block(css, ':root[data-theme="dark-pink"] {');

function merge(...layers: Tokens[]): Tokens {
  return Object.assign({}, ...layers);
}

// The six states the app can actually produce, each as an ordered layer
// list mirroring real selector precedence (later layers override earlier).
const THEMES: Record<string, Tokens> = {
  light: merge(ROOT_LIGHT),
  dark: merge(ROOT_LIGHT, DARK),
  "bright-pink": merge(ROOT_LIGHT, PINK_SHARED_LIGHT),
  "auto-pink (light)": merge(ROOT_LIGHT, PINK_SHARED_LIGHT),
  "auto-pink (dark)": merge(ROOT_LIGHT, DARK, PINK_AUTO_DARK),
  "dark-pink": merge(ROOT_LIGHT, DARK, PINK_DARK),
};

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function parseHsl(value: string): [number, number, number] {
  const m = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(value.trim());
  if (!m) throw new Error(`not a bare H S% L% triplet: "${value}"`);
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const chan = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [rl, gl, bl] = [chan(r), chan(g), chan(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(parseHsl(a));
  const lb = relativeLuminance(parseHsl(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function tok(tokens: Tokens, name: string): string {
  const v = tokens[name];
  if (!v) throw new Error(`token --${name} missing from resolved theme`);
  return v;
}

// [pair label, fg token, bg token, minimum ratio]
const TEXT_PAIRS: Array<[string, string, string, number]> = [
  ["foreground on background", "foreground", "background", 7.0],
  ["muted-foreground on background", "muted-foreground", "background", 4.5],
  ["muted-foreground on card", "muted-foreground", "card", 4.5],
  ["primary-foreground on primary", "primary-foreground", "primary", 4.5],
  ["destructive-foreground on destructive", "destructive-foreground", "destructive", 4.5],
  ["success-muted-foreground on success-muted", "success-muted-foreground", "success-muted", 4.5],
  ["warning-muted-foreground on warning-muted", "warning-muted-foreground", "warning-muted", 4.5],
  ["info-muted-foreground on info-muted", "info-muted-foreground", "info-muted", 4.5],
  [
    "destructive-muted-foreground on destructive-muted",
    "destructive-muted-foreground",
    "destructive-muted",
    4.5,
  ],
  ["sidebar-fg on sidebar-bg", "sidebar-fg", "sidebar-bg", 4.5],
  ["sidebar-active on sidebar-bg", "sidebar-active", "sidebar-bg", 4.5],
];

// Non-text UI (WCAG 1.4.11, 3.0 minimum). Scoped to tokens that actually
// stand in for an interactive component's boundary: --input (form control
// borders) and --ring (focus indicator). --border is deliberately excluded
// — it's the decorative card/table/panel hairline the "hairlines not
// shadows" direction calls for, not a required-to-identify-the-component
// boundary, and layout/spacing already conveys those groupings without it.
const UI_PAIRS: Array<[string, string, string, number]> = [
  ["input on background", "input", "background", 3.0],
  ["input on card", "input", "card", 3.0],
  ["ring on background", "ring", "background", 3.0],
];

describe("design token contrast (WCAG)", () => {
  for (const [themeName, tokens] of Object.entries(THEMES)) {
    describe(themeName, () => {
      for (const [label, fg, bg, min] of [...TEXT_PAIRS, ...UI_PAIRS]) {
        it(`${label} >= ${min}:1`, () => {
          const ratio = contrast(tok(tokens, fg), tok(tokens, bg));
          assert.ok(
            ratio >= min,
            `${label} in "${themeName}" is ${ratio.toFixed(2)}:1, needs >= ${min}:1 ` +
              `(--${fg}: ${tok(tokens, fg)} on --${bg}: ${tok(tokens, bg)})`,
          );
        });
      }
    });
  }

  it("every theme resolves a value for every checked token (catches a pink block missing a new token)", () => {
    const checked = new Set([...TEXT_PAIRS, ...UI_PAIRS].flatMap(([, fg, bg]) => [fg, bg]));
    for (const [themeName, tokens] of Object.entries(THEMES)) {
      for (const name of checked) {
        assert.ok(tokens[name], `theme "${themeName}" is missing --${name}`);
      }
    }
  });
});

describe("prefers-contrast: more", () => {
  // The media-query block groups selectors into a light-base set and a
  // dark-base set. dark-pink must be in the dark-base set even though its
  // *default* tokens are declared without a ".dark" prefix, because
  // :root[data-theme="dark-pink"] alone outranks plain ".dark" on
  // specificity — if it were grouped with the light-base selectors it
  // would win the cascade and apply light-tuned values on dark-pink's
  // actual (always-dark) canvas. This test parses the media block directly
  // rather than trusting a comment to stay honest about the grouping.
  const mediaStart = css.indexOf("@media (prefers-contrast: more)");
  assert.ok(mediaStart !== -1, "prefers-contrast: more block must exist");
  const mediaBody = css.slice(mediaStart, css.indexOf("\n}\n", mediaStart) + 3);

  const lightGroupStart = mediaBody.indexOf(":root,");
  const darkGroupStart = mediaBody.indexOf(".dark,");
  const lightGroupSelectors = mediaBody.slice(lightGroupStart, darkGroupStart);
  const darkGroupSelectors = mediaBody.slice(darkGroupStart, mediaBody.indexOf("{", darkGroupStart));

  it("keeps dark-pink out of the light-base selector group", () => {
    assert.doesNotMatch(lightGroupSelectors, /dark-pink/);
  });

  it("puts dark-pink in the dark-base selector group", () => {
    assert.match(darkGroupSelectors, /dark-pink/);
  });

  it("raises border contrast above the non-boosted value in both base groups", () => {
    const boostedLight = block(mediaBody, ":root,");
    const boostedDark = block(mediaBody, ".dark,");
    const baseline = contrast(ROOT_LIGHT.border, ROOT_LIGHT.background);
    const boosted = contrast(boostedLight.border, ROOT_LIGHT.background);
    assert.ok(boosted > baseline, `light border boost (${boosted.toFixed(2)}) must exceed baseline (${baseline.toFixed(2)})`);

    const baselineDark = contrast(DARK.border, DARK.background);
    const boostedDarkRatio = contrast(boostedDark.border, DARK.background);
    assert.ok(
      boostedDarkRatio > baselineDark,
      `dark border boost (${boostedDarkRatio.toFixed(2)}) must exceed baseline (${baselineDark.toFixed(2)})`,
    );
  });
});
