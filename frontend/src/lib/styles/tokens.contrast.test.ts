import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const css = readFileSync(resolve(ROOT, "frontend/src/app.css"), "utf8");
type Tokens = Record<string, string>;
function block(anchor: string): Tokens {
  const start = css.indexOf(anchor); assert.ok(start !== -1, `missing ${anchor}`);
  const open = css.indexOf("{", start); const close = css.indexOf("}", open);
  return Object.fromEntries([...css.slice(open + 1, close).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}
const light = block(":root {");
const dark = { ...light, ...block(".dark {") };
const sidebar = { ...dark, ...block(".sidebar-surface {") };
function rgb(value: string): [number, number, number] {
  const match = /^(\d+)\s+(\d+)%\s+(\d+)%$/.exec(value); assert.ok(match, `invalid HSL token ${value}`);
  const [h, s, l] = [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100];
  const a = s * Math.min(l, 1 - l); const f = (n: number) => l - a * Math.max(-1, Math.min((n + h / 30) % 12 - 3, Math.min(9 - ((n + h / 30) % 12), 1)));
  return [f(0), f(8), f(4)];
}
function contrast(a: string, b: string) {
  const luminance = ([r, g, b]: [number, number, number]) => {
    const linear = (v: number) => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    return .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
  };
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))]; return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
describe("neutral theme contrast", () => {
  for (const [name, tokens] of Object.entries({ light, dark })) {
    it(`${name} retains readable text and visible controls`, () => {
      for (const [fg, bg, min] of [["foreground", "background", 7], ["muted-foreground", "card", 4.5], ["primary-foreground", "primary", 4.5], ["input", "background", 3], ["ring", "background", 3]] as const) {
        assert.ok(contrast(tokens[fg]!, tokens[bg]!) >= min, `${name}: ${fg} on ${bg}`);
      }
    });
  }
  it("does not ship branded palette selectors or decorative serif faces", () => {
    assert.doesNotMatch(css, /pink|Source Serif|data-theme/);
  });
  it("keeps navigation labels readable on its dark rail in every mode", () => {
    assert.ok(contrast(sidebar["muted-foreground"]!, sidebar["sidebar-bg"]!) >= 4.5, "sidebar muted label contrast");
    assert.ok(contrast(sidebar["sidebar-fg"]!, sidebar.card!) >= 4.5, "sidebar account contrast");
  });
});
