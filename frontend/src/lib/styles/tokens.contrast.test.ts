import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
// Tokens live in their own file because the portal under /go imports them
// without the admin's Tailwind entrypoint; app.css still owns the surfaces that
// re-declare tokens locally, so both are scanned.
const tokensCss = readFileSync(resolve(ROOT, "frontend/src/lib/styles/tokens.css"), "utf8");
const css = `${tokensCss}\n${readFileSync(resolve(ROOT, "frontend/src/app.css"), "utf8")}`;
type Tokens = Record<string, string>;
function block(anchor: string): Tokens {
  const start = css.indexOf(anchor); assert.ok(start !== -1, `missing ${anchor}`);
  const open = css.indexOf("{", start); const close = css.indexOf("}", open);
  return Object.fromEntries([...css.slice(open + 1, close).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}
const light = block(":root {");
const darkBlock = block(".dark {");
const autoDarkBlock = block(":root[data-auto-scheme] {");
const dark = { ...light, ...darkBlock };
const sidebar = { ...dark, ...block(".sidebar-surface {") };
const portalAutoDark = { ...light, ...autoDarkBlock };
function rgb(value: string): [number, number, number] {
  const match = /^(\d+)\s+(\d+)%\s+(\d+)%$/.exec(value); assert.ok(match, `invalid HSL token ${value}`);
  const [h, s, l] = [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100];
  const a = s * Math.min(l, 1 - l); const f = (n: number) => l - a * Math.max(-1, Math.min((n + h / 30) % 12 - 3, Math.min(9 - ((n + h / 30) % 12), 1)));
  return [f(0), f(8), f(4)];
}
/** `#rrggbb` -> the "H S% L%" token form, so graph hexes go through the same contrast math. */
function hexToken(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex); assert.ok(match, `invalid hex ${hex}`);
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => parseInt(part!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2; const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return `${Math.round((h + 360) % 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}
function contrast(a: string, b: string, opacity = 1, backdrop = b) {
  const luminance = ([r, g, b]: [number, number, number]) => {
    const linear = (v: number) => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    return .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
  };
  const base = rgb(backdrop);
  const background = rgb(b).map((value, i) => opacity * value + (1 - opacity) * base[i]!) as [number, number, number];
  const [x, y] = [luminance(rgb(a)), luminance(background)]; return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
describe("neutral theme contrast", () => {
  for (const [name, tokens] of Object.entries({ light, dark, "portal auto dark": portalAutoDark })) {
    it(`${name} retains readable text and visible controls`, () => {
      for (const [fg, bg, min] of [["foreground", "background", 7], ["muted-foreground", "card", 4.5], ["primary-foreground", "primary", 4.5], ["destructive-foreground", "destructive", 4.5], ["input", "background", 3], ["ring", "background", 3]] as const) {
        assert.ok(contrast(tokens[fg]!, tokens[bg]!) >= min, `${name}: ${fg} on ${bg}`);
      }
      for (const surface of ["background", "card"]) {
        assert.ok(contrast(tokens.destructive!, tokens[surface]!) >= 4.5, `${name}: destructive text on ${surface}`);
      }
      // Rich-colour toast titles use the same semantic surface/text pairs.
      for (const status of ["success", "info", "warning", "destructive"]) {
        assert.ok(contrast(tokens[`${status}-muted-foreground`]!, tokens[`${status}-muted`]!) >= 4.5,
          `${name}: ${status} toast text on its muted surface`);
      }
      for (const surface of ["background", "card", "popover", "sidebar-bg"]) {
        for (const opacity of [.8, .9]) {
          assert.ok(contrast(tokens["destructive-foreground"]!, tokens.destructive!, opacity, tokens[surface]!) >= 4.5,
            `${name}: destructive hover at ${opacity} on ${surface}`);
        }
      }
    });
  }
  it("does not ship branded palette selectors or decorative serif faces", () => {
    assert.doesNotMatch(css, /pink|Source Serif|data-theme/);
  });
  // The portal cannot run the admin's inline theme bootstrap (script-src 'self'),
  // so it gets dark through a media query instead of the .dark class. The two
  // blocks are duplicated by necessity; this is what stops them drifting.
  it("keeps the portal's media-query dark block identical to .dark", () => {
    assert.deepEqual(autoDarkBlock, darkBlock);
  });
  /**
   * The portal's engine avatar puts white on these at 10-11px, and neither was
   * covered here -- so `--persona-codex` shipped at 3.89:1 until Axe caught it
   * against the live /go page. Small white-on-brand text is exactly the case
   * that needs a floor.
   */
  it("keeps white legible on all persona colours", () => {
    assert.equal(light["persona-foreground"], "0 0% 100%", "--persona-foreground is the white the avatars use");
    assert.equal(darkBlock["persona-foreground"], undefined, "persona fills do not change with the theme, so neither does their text");
    for (const persona of ["persona-codex", "persona-claude", "persona-grok", "persona-kimi"]) {
      const value = light[persona];
      assert.ok(value, `missing --${persona}`);
      assert.ok(
        contrast(value, light["persona-foreground"]!) >= 4.5,
        `${persona} carries white text on the portal avatar and must clear 4.5:1`,
      );
    }
  });
  // Memory Atlas category hues are flat hexes shared by both themes; each edge,
  // border and minimap mark must clear the 3:1 graphical-object floor everywhere.
  it("keeps every graph palette hue visible on light and dark surfaces", () => {
    const palette = readFileSync(resolve(ROOT, "frontend/src/lib/constants/graph-palette.ts"), "utf8");
    const hexes = [...palette.matchAll(/^(?:export )?const (\w+) = "(#[0-9a-f]{6})"/gim)].map((match) => [match[1]!, match[2]!] as const);
    assert.ok(hexes.length >= 6, "graph palette hues not found");
    for (const [name, hex] of hexes) {
      for (const [mode, tokens] of Object.entries({ light, dark })) {
        for (const surface of ["background", "card"]) {
          assert.ok(contrast(hexToken(hex), tokens[surface]!) >= 3, `${name} ${hex} on ${mode} ${surface}`);
        }
      }
    }
  });
  it("keeps navigation labels readable on its dark rail in every mode", () => {
    assert.ok(contrast(sidebar["muted-foreground"]!, sidebar["sidebar-bg"]!) >= 4.5, "sidebar muted label contrast");
    assert.ok(contrast(sidebar["sidebar-fg"]!, sidebar.card!) >= 4.5, "sidebar account contrast");
  });
});
