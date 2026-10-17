<script lang="ts">
  /** Compact usage for one account: a thin bar and percent per window, with the reset as relative text. */
  import type { ProviderAccount } from "$lib/api/accounts";
  import { resetsIn } from "$lib/utils/format";
  import { cn } from "$lib/utils/cn";

  let { account }: { account: ProviderAccount } = $props();

  type Meter = { label: string; used: number | null; reset: string | null };
  const usage = $derived(account.usage);
  const meters = $derived.by<Meter[]>(() => {
    if (account.engine === "grok") {
      const window = usage.current_window;
      return window ? [{ label: window.period === "monthly" ? "Monthly" : window.period === "weekly" ? "Weekly" : "Current period", used: window.used_percent, reset: window.resets_at }] : [];
    }
    if (usage.supported === false) return [];
    return [
      { label: "Short", used: usage.short_used_percent, reset: usage.short_resets_at },
      { label: "Weekly", used: usage.weekly_used_percent, reset: usage.weekly_resets_at },
    ];
  });
  const note = $derived.by(() => {
    if (account.engine === "grok") return meters.length ? "" : usage.checked_at ? "Usage unavailable" : "Waiting for usage data";
    return usage.supported === false ? "Quota not reported by this provider" : "";
  });
  const tone = (used: number) => (used >= 95 ? "bg-destructive" : used >= 80 ? "bg-warning" : "bg-primary");
  function reset(value: string | null) {
    const when = resetsIn(value);
    if (when === "passed") return "reset passed";
    if (when) return `resets ${when}`;
    return account.engine === "grok" ? "Reset time unavailable" : "";
  }
</script>

{#if meters.length}
  <div role="group" aria-label={account.engine === "grok" ? `${account.label} Grok usage` : `${account.label} usage`}>
  <ul class="space-y-1">
    {#each meters as meter (meter.label)}
      <li class="flex items-center gap-2 text-caption">
        <span class="w-12 shrink-0 text-muted-foreground">{meter.label}</span>
        {#if meter.used === null}
          <span class="text-muted-foreground">Unknown</span>
        {:else}
          <div class="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted" role="meter" aria-label="{meter.label} usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter.used} aria-valuetext="{meter.used}%">
            <div class={cn("h-full rounded-full", tone(meter.used))} style="width: {Math.min(100, Math.max(0, meter.used))}%"></div>
          </div>
          <span class="w-9 shrink-0 text-right font-medium tabular-nums">{meter.used}%</span>
        {/if}
        {#if reset(meter.reset)}<time class="truncate text-muted-foreground" datetime={meter.reset ?? undefined} title={meter.reset ?? undefined}>{reset(meter.reset)}</time>{/if}
      </li>
    {/each}
  </ul>
  {#if usage.stale && account.engine !== "grok"}<p class="mt-0.5 text-caption text-muted-foreground">Last known reading</p>{/if}
  </div>
{:else}
  <span class="text-caption text-muted-foreground" role="group" aria-label={account.engine === "grok" ? `${account.label} Grok usage` : undefined}>{note}</span>
{/if}
