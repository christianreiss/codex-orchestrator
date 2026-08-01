<script lang="ts" module>
  /**
   * Chart.js auto-registration. Module-level so it runs exactly once even
   * if multiple TrendChart components mount on the same route.
   */
  import {
    Chart,
    LineController,
    LineElement,
    PointElement,
    LinearScale,
    TimeScale,
    CategoryScale,
    Tooltip,
    Filler,
    Legend,
  } from "chart.js";
  import "chartjs-adapter-date-fns";
  import zoomPlugin from "chartjs-plugin-zoom";

  let registered = false;
  function ensureRegistered() {
    if (registered) return;
    Chart.register(
      LineController,
      LineElement,
      PointElement,
      LinearScale,
      TimeScale,
      CategoryScale,
      Tooltip,
      Filler,
      Legend,
      zoomPlugin,
    );
    registered = true;
  }
</script>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { ChartConfiguration, ChartDataset, Point } from "chart.js";
  import { cn } from "$lib/utils/cn";
  import {
    readCssVar,
    chartPalette,
    chartTooltipBg,
    chartTooltipFg,
    themeVersion,
  } from "$lib/utils/theme-colors";

  /** Alpha applied to the border palette to derive dataset fill colors. */
  const FILL_ALPHA = 0.15;

  type Series = {
    label: string;
    data: Array<{ x: string | number; y: number }>;
    color?: string;
    fill?: boolean;
  };

  type Props = {
    series: Series[];
    height?: number;
    class?: string;
    /** When true, draws a percentage y-axis fixed to 0-100. */
    percent?: boolean;
    timeUnit?: "hour" | "day" | "week" | "month";
  };

  let { series, height = 240, class: className, percent = false, timeUnit = "day" }: Props = $props();

  let canvas: HTMLCanvasElement | undefined;
  let chart: Chart<"line"> | null = null;

  function buildConfig(): ChartConfiguration<"line"> {
    const muted = readCssVar("--muted-foreground", "hsl(220 8.9% 46.1%)");
    const border = readCssVar("--border", "hsl(220 13% 91%)");

    const borderPalette = chartPalette();
    const fillPalette = chartPalette(FILL_ALPHA);

    const datasets: ChartDataset<"line">[] = series.map((s, i): ChartDataset<"line"> => ({
      label: s.label,
      data: s.data.map((p): Point => ({
        x: typeof p.x === "number" ? p.x : new Date(p.x).getTime(),
        y: p.y,
      })),
      borderColor: s.color ?? borderPalette[i % borderPalette.length],
      backgroundColor: s.color ?? fillPalette[i % fillPalette.length],
      fill: s.fill ?? false,
      tension: 0.3,
      pointRadius: 0,
      pointHoverRadius: 3,
      borderWidth: 1.5,
    }));

    return {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: { padding: 8 },
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            type: "time",
            time: { unit: timeUnit },
            grid: { color: border, drawTicks: false },
            ticks: { color: muted, font: { size: 10 }, maxRotation: 0 },
            border: { display: false },
          },
          y: {
            beginAtZero: true,
            ...(percent ? { min: 0, max: 100 } : {}),
            grid: { color: border, drawTicks: false },
            ticks: {
              color: muted,
              font: { size: 10 },
              callback: (value: number | string) => (percent ? `${value}%` : value),
            },
            border: { display: false },
          },
        },
        plugins: {
          legend: {
            display: datasets.length > 1,
            position: "bottom",
            labels: { color: muted, font: { size: 11 }, boxWidth: 8, boxHeight: 8 },
          },
          tooltip: {
            backgroundColor: chartTooltipBg(),
            titleColor: chartTooltipFg(),
            bodyColor: chartTooltipFg(),
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
            cornerRadius: 4,
            displayColors: true,
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y ?? 0;
                return ` ${ctx.dataset.label}: ${percent ? `${v}%` : v.toLocaleString()}`;
              },
            },
          },
          zoom: {
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              mode: "x",
            },
            pan: { enabled: true, mode: "x" },
          },
        },
      },
    };
  }

  onMount(() => {
    ensureRegistered();
    if (!canvas) return;
    chart = new Chart(canvas, buildConfig());
  });

  onDestroy(() => {
    chart?.destroy();
    chart = null;
  });

  // Rebuild on series change, and on theme switches (light/dark or a pink
  // palette variant) even when the underlying data hasn't changed — Chart.js
  // paints to <canvas>, so a CSS variable change alone won't repaint it.
  $effect(() => {
    if (!chart) return;
    void $themeVersion;
    const cfg = buildConfig();
    chart.data = cfg.data;
    chart.options = cfg.options as Chart<"line">["options"];
    chart.update("none");
  });
</script>

<div class={cn("relative w-full", className)} style="height:{height}px">
  <canvas bind:this={canvas}></canvas>
</div>
