/**
 * Categorical / qualitative color palette for the Memory Atlas graph
 * (edge types, memory scopes, and non-memory node kinds).
 *
 * This is intentionally separate from the semantic success/warning/info/
 * destructive design tokens in tailwind.config.ts — those carry meaning
 * ("this is a warning"), while these hues exist only to give otherwise
 * unrelated graph categories strong, stable visual separation so the
 * relationship map and its legend stay legible at a glance.
 *
 * MemoryGraph.svelte and MemoryGraphNode.svelte both import from here so
 * the category -> color mapping lives in exactly one place. The "Fleet
 * shared / Project / Host scratch" totals tiles on the Memory Atlas page
 * are that same shared/project/host legend rendered as stat cards, so they
 * import SCOPE_COLORS too rather than carrying their own copy.
 *
 * Each value below is a single flat hex used identically in light and dark
 * mode (no `dark:` variant), so it sits at mid luminance: every hue clears
 * the >=3.0:1 WCAG 1.4.11 graphical-object floor against the light and dark
 * `--background` and `--card` tokens. lib/styles/tokens.contrast.test.ts
 * reads this file and enforces that floor.
 */
import type { MemoryGraphEdgeType, MemoryScope } from "$lib/api/memories";

// Base hues, named for the category that "owns" them. Several categories
// intentionally share a hue (e.g. the "in_project" edge and the "project"
// scope, or the "in_scope" edge and the "shared" scope), mirroring the
// original inline color choices.
const TAG_GREEN = "#0c8d62"; // #10b981 darkened to clear 3:1 on the light canvas
const HOST_AMBER = "#ab6e07"; // #f59e0b darkened to clear 3:1 on the light canvas
const ENGINE_ROSE = "#c15c6f"; // re-hued from cold fuchsia #d946ef
const PROJECT_OLIVE = "#798131"; // re-hued from cold cyan #06b6d4
const SHARED_PLUM = "#bd51b4"; // re-hued from cold violet #8b5cf6

/** Edge type -> stroke/marker color for the relationship graph. */
export const EDGE_COLORS: Record<MemoryGraphEdgeType, string> = {
  tagged_with: TAG_GREEN,
  from_engine: ENGINE_ROSE,
  written_by: ENGINE_ROSE,
  in_project: PROJECT_OLIVE,
  owned_by: HOST_AMBER,
  in_scope: SHARED_PLUM,
};

/** Memory scope -> accent color, used for memory node borders/icons and the minimap. */
export const SCOPE_COLORS: Record<MemoryScope, string> = {
  shared: SHARED_PLUM,
  project: PROJECT_OLIVE,
  host: HOST_AMBER,
};

/** Non-memory node kinds that also carry a categorical accent (tag/engine chips). */
export const NODE_KIND_COLORS: Record<"tag" | "engine", string> = {
  tag: TAG_GREEN,
  engine: ENGINE_ROSE,
};

/** Fallback accent for minimap entries (or anything else) with no recognized scope. */
export const DEFAULT_NODE_COLOR = "#64748b";

/**
 * Appends an alpha channel to a `#rrggbb` hex color, e.g. `withAlpha("#ab6e07", 0.1)`
 * -> `"#ab6e071a"`. These are custom hex values (not Tailwind palette stops) picked
 * dynamically per category, so consumers apply them via inline style rather than
 * Tailwind utility classes — dynamic class names built from interpolated strings
 * aren't visible to Tailwind's build-time scanner.
 */
export function withAlpha(hex: string, alpha: number): string {
  const channel = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${channel}`;
}
