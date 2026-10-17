<script lang="ts">
  /**
   * Quota meter: horizontal bar showing live + cached fractions of a limit.
   * `inline` lays label, bar and value on one line for dense lists.
   */
  import { cn } from "$lib/utils/cn";

  type Props = {
    /** Total percent used (0-100+). Anything > 100 clamps and tints the bar red. */
    usedPercent: number;
    /** Optional portion of `usedPercent` that came from cached data. */
    cachedPercent?: number | null;
    label?: string;
    /** Trailing label rendered to the right of the bar (e.g. "47%"). */
    valueLabel?: string;
    inline?: boolean;
    class?: string;
  };

  let { usedPercent, cachedPercent = null, label, valueLabel, inline = false, class: className }: Props = $props();

  const clamped = $derived(Math.max(0, Math.min(110, Number.isFinite(usedPercent) ? usedPercent : 0)));
  const cached = $derived(
    cachedPercent === null || !Number.isFinite(cachedPercent) ? 0 : Math.max(0, Math.min(clamped, cachedPercent ?? 0)),
  );
  const live = $derived(Math.max(0, clamped - cached));
  const overLimit = $derived(clamped > 100);
  const meterTone = $derived(overLimit || clamped >= 90 ? "bg-destructive" : clamped >= 70 ? "bg-warning" : "bg-primary");
</script>

{#snippet bar()}
  <div
    class={cn("relative w-full overflow-hidden rounded-full bg-muted", inline ? "h-1.5" : "h-2")}
    role="meter"
    aria-valuenow={Math.round(Math.min(100, clamped))}
    aria-valuetext={valueLabel ?? `${Math.round(clamped)}% used`}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label={label ?? "usage"}
  >
    {#if cached > 0}
      <div class="absolute inset-y-0 left-0 bg-muted-foreground/40" style="width: {Math.min(100, cached)}%" title="Cached"></div>
    {/if}
    {#if live > 0}
      <div
        class={cn("absolute inset-y-0 transition-[width] duration-300", meterTone)}
        style="left: {Math.min(100, cached)}%; width: {Math.min(100 - Math.min(100, cached), live)}%"
        title="Live"
      ></div>
    {/if}
    {#if overLimit}<div class="absolute inset-y-0 right-0 w-px bg-destructive/80" aria-hidden="true"></div>{/if}
  </div>
{/snippet}

{#if inline}
  <div class={cn("flex items-center gap-2 text-body-sm", className)}>
    {#if label}<span class="w-28 shrink-0 truncate text-muted-foreground">{label}</span>{/if}
    <div class="min-w-16 flex-1">{@render bar()}</div>
    {#if valueLabel}<span class={cn("w-16 shrink-0 text-right tabular-nums", overLimit && "text-destructive")}>{valueLabel}</span>{/if}
  </div>
{:else}
  <div class={cn("flex flex-col gap-1.5", className)}>
    {#if label || valueLabel}
      <div class="flex items-baseline justify-between text-body-sm">
        {#if label}<span class="font-medium text-muted-foreground">{label}</span>{:else}<span></span>{/if}
        {#if valueLabel}<span class={cn("font-medium tabular-nums", overLimit ? "text-destructive" : "text-foreground")}>{valueLabel}</span>{/if}
      </div>
    {/if}
    {@render bar()}
  </div>
{/if}
