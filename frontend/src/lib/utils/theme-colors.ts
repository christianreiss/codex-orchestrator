/**
 * Chart color helpers that track the CSS custom-property theme (light/dark
 * plus the pink `data-theme` palette variants) without needing a page
 * reload.
 *
 * Chart.js paints to a `<canvas>`, so its colors don't repaint for free the
 * way DOM elements inheriting `currentColor` do — a chart has to re-read
 * these CSS variables and explicitly re-render whenever the theme changes.
 * `themeVersion` is the "the theme changed, go re-read the variables"
 * signal; the `readCssVar`/`chart*` helpers below are what to re-read.
 */
import { readable } from "svelte/store";
import { browser } from "$app/environment";

/**
 * Resolve a `--foo` custom property (stored, per app.css, as a bare
 * `H S% L%` triple) into a usable `hsl()` color string. Returns `fallback`
 * verbatim outside the browser (SSR) or when the variable isn't set.
 *
 * Pass `alpha` (0-1) to get the CSS `hsl(H S% L% / alpha)` alpha syntax back
 * instead of an opaque color. Do NOT reintroduce the old trick of
 * string-concatenating a hex suffix (e.g. `color + "22"`) onto an already
 * built `hsl(...)` string to fake opacity — `hsl(0 0% 0%)22` is not a valid
 * CSS color, and browsers silently drop that assignment rather than erroring.
 */
export function readCssVar(name: string, fallback: string, alpha?: number): string {
  if (!browser) return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (value === "") return fallback;
  return alpha === undefined ? `hsl(${value})` : `hsl(${value} / ${alpha})`;
}

/**
 * Ordered series colors for multi-line charts, sourced from the active
 * theme. Pass `alpha` to get translucent versions (e.g. for fill areas)
 * derived from the same underlying variables, instead of hand-rolling
 * opacity on top of an already-resolved color string.
 */
export function chartPalette(alpha?: number): string[] {
  return [
    readCssVar("--primary", "hsl(17 88% 40%)", alpha),
    readCssVar("--muted-foreground", "hsl(27 4% 42%)", alpha),
    readCssVar("--info", "hsl(205 45% 38%)", alpha),
    readCssVar("--warning", "hsl(26 90% 37%)", alpha),
  ];
}

/** Chart.js tooltip background — the app's popover surface, slightly translucent. */
export function chartTooltipBg(): string {
  return readCssVar("--popover", "hsl(45 100% 99% / 0.95)", 0.95);
}

/** Chart.js tooltip text color, matching the app's popover surface. */
export function chartTooltipFg(): string {
  return readCssVar("--popover-foreground", "hsl(27 20% 9%)");
}

/**
 * Bumps whenever `<html>`'s `class` (light/dark, toggled by mode-watcher via
 * `setTheme` in `$lib/stores/theme.ts`) or `data-theme` (pink palette
 * variant, toggled by `applyPaletteAttr` in the same file) attribute
 * changes — the two independent mechanisms theme switching uses. Components
 * that derive Chart.js colors from CSS variables should read this store's
 * value inside their re-render effect and force a redraw on change (canvas
 * painting doesn't inherit CSS updates the way DOM elements do).
 *
 * The MutationObserver is created lazily on the first subscription (and
 * torn down when the last subscriber leaves), so importing this module has
 * no side effects, and it never runs during SSR.
 */
export const themeVersion = readable(0, (set) => {
  if (!browser) return;
  let version = 0;
  const observer = new MutationObserver(() => {
    version += 1;
    set(version);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
  return () => observer.disconnect();
});
