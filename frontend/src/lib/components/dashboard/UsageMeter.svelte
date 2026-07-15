<script lang="ts">
  /**
   * Quota meter: stacked horizontal bar showing live + cached fractions of
   * a limit. Falls back to a single bar when no cached fraction is given.
   */
  import { cn } from "$lib/utils/cn";

  type Props = {
    /** Total percent used (0-100+). Anything > 100 clamps and tints the bar red. */
    usedPercent: number;
    /** Optional portion of `usedPercent` that came from cached data. */
    cachedPercent?: number | null;
    label?: string;
    /** Trailing label rendered to the right of the bar (e.g. "47/100"). */
    valueLabel?: string;
    class?: string;
  };

  let {
    usedPercent,
    cachedPercent = null,
    label,
    valueLabel,
    class: className,
  }: Props = $props();

  const clamped = $derived(Math.max(0, Math.min(110, Number.isFinite(usedPercent) ? usedPercent : 0)));
  const cached = $derived(
    cachedPercent === null || !Number.isFinite(cachedPercent)
      ? 0
      : Math.max(0, Math.min(clamped, cachedPercent ?? 0)),
  );
  const live = $derived(Math.max(0, clamped - cached));
  const overLimit = $derived(clamped > 100);
  const meterTone = $derived(
    overLimit || clamped >= 90 ? "bg-destructive" : clamped >= 70 ? "bg-amber-500" : "bg-primary",
  );
</script>

<div class={cn("flex flex-col gap-1.5", className)}>
  {#if label || valueLabel}
    <div class="flex items-baseline justify-between text-xs">
      {#if label}
        <span class="font-medium text-muted-foreground">{label}</span>
      {:else}
        <span></span>
      {/if}
      {#if valueLabel}
        <span class="tabular-nums font-medium {overLimit ? 'text-destructive' : 'text-foreground'}">{valueLabel}</span>
      {/if}
    </div>
  {/if}
  <div
    class="relative h-2.5 w-full overflow-hidden rounded-full bg-muted"
    role="meter"
    aria-valuenow={Math.round(clamped)}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label={label ?? "usage"}
  >
    {#if cached > 0}
      <div
        class="absolute inset-y-0 left-0 bg-muted-foreground/40"
        style="width: {Math.min(100, cached)}%"
        title="Cached"
      ></div>
    {/if}
    {#if live > 0}
      <div
        class={cn(
          "absolute inset-y-0 transition-[width] duration-300",
          meterTone,
        )}
        style="left: {Math.min(100, cached)}%; width: {Math.min(100 - Math.min(100, cached), live)}%"
        title="Live"
      ></div>
    {/if}
    {#if overLimit}
      <div
        class="absolute inset-y-0 right-0 w-px bg-destructive/80"
        aria-hidden="true"
      ></div>
    {/if}
  </div>
</div>
