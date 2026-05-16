<script lang="ts">
  /**
   * Tiny inline SVG sparkline. Intentionally not a Chart.js instance — one
   * lightweight sparkline per card vs an instantiated chart canvas.
   */
  import { cn } from "$lib/utils/cn";

  type Point = { ts?: string; value: number };

  type Props = {
    points: Point[];
    width?: number;
    height?: number;
    class?: string;
    /** Color of the line + fill. Defaults to a neutral gray that picks up theme. */
    color?: string;
    fill?: boolean;
    /** Optional baseline (e.g. 100 for percent series). When set, the y-axis is fixed. */
    max?: number;
    min?: number;
  };

  let {
    points,
    width = 160,
    height = 40,
    class: className,
    color = "currentColor",
    fill = true,
    max,
    min,
  }: Props = $props();

  const safePoints = $derived(points.filter((p) => Number.isFinite(p.value)));

  const bounds = $derived.by(() => {
    if (safePoints.length === 0) return { lo: 0, hi: 1 };
    const values = safePoints.map((p) => p.value);
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    let lo = min ?? dataMin;
    let hi = max ?? dataMax;
    if (hi - lo < 1e-6) hi = lo + 1;
    return { lo, hi };
  });

  function pathData(pts: Point[], lo: number, hi: number, w: number, h: number, closed: boolean) {
    if (pts.length === 0) return "";
    if (pts.length === 1) {
      const x = w / 2;
      const y = h - ((pts[0].value - lo) / (hi - lo)) * h;
      return closed ? `M0,${h} L${x},${y} L${w},${h} Z` : `M${x},${y} L${x},${y}`;
    }
    const step = w / (pts.length - 1);
    const coords = pts.map((p, i) => {
      const x = i * step;
      const y = h - ((p.value - lo) / (hi - lo)) * h;
      return [x, y] as const;
    });
    let d = `M${coords[0][0]},${coords[0][1]}`;
    for (let i = 1; i < coords.length; i++) {
      d += ` L${coords[i][0]},${coords[i][1]}`;
    }
    if (closed) {
      d += ` L${coords[coords.length - 1][0]},${h} L0,${h} Z`;
    }
    return d;
  }

  const linePath = $derived(pathData(safePoints, bounds.lo, bounds.hi, width, height, false));
  const fillPath = $derived(pathData(safePoints, bounds.lo, bounds.hi, width, height, true));
</script>

{#if safePoints.length === 0}
  <div class={cn("flex items-center justify-center text-xs text-muted-foreground", className)} style="width:{width}px;height:{height}px">
    —
  </div>
{:else}
  <svg
    role="img"
    aria-label="trend sparkline"
    viewBox="0 0 {width} {height}"
    width={width}
    height={height}
    class={cn("overflow-visible", className)}
    preserveAspectRatio="none"
  >
    {#if fill}
      <path d={fillPath} fill={color} fill-opacity="0.12" stroke="none" />
    {/if}
    <path d={linePath} fill="none" stroke={color} stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
  </svg>
{/if}
