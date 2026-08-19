<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Alert, AlertTitle, AlertDescription } from "$lib/components/ui/alert";
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
  } from "$lib/components/ui/dialog";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import LineChart from "@lucide/svelte/icons/line-chart";
  import UsageMeter from "$lib/components/dashboard/UsageMeter.svelte";
  import Sparkline from "$lib/components/dashboard/Sparkline.svelte";
  import TrendChart from "$lib/components/dashboard/TrendChart.svelte";
  import { claudeUsageQuery, claudeHistoryQuery } from "$lib/api/usage";
  import { relativeTime } from "$lib/utils/format";

  const usage = claudeUsageQuery();
  const history = claudeHistoryQuery(60);

  let historyOpen = $state(false);

  const snapshot = $derived($usage.data?.snapshot ?? null);
  const fetchedAt = $derived(snapshot?.fetched_at ?? null);
  const source = $derived(snapshot?.source ?? null);

  const fiveHourPercent = $derived(
    typeof snapshot?.five_hour_used_percent === "number" ? snapshot.five_hour_used_percent : null,
  );
  const sevenDayPercent = $derived(
    typeof snapshot?.seven_day_used_percent === "number" ? snapshot.seven_day_used_percent : null,
  );

  const sparkPoints = $derived(
    ($history.data?.series ?? [])
      .find((s) => s.key === "seven_day" && s.points.length > 0)
      ?.points.map((p) => ({ ts: p.ts, value: p.value })) ??
      ($history.data?.series ?? []).find((s) => s.key === "five_hour")?.points.map((p) => ({
        ts: p.ts,
        value: p.value,
      })) ??
      [],
  );

  const chartSeries = $derived(
    ($history.data?.series ?? []).map((s) => ({
      label: s.label,
      data: s.points.map((p) => ({ x: p.ts, y: p.value })),
    })),
  );

  function handleRefresh() {
    void $usage.refetch();
    void $history.refetch();
  }
</script>

<Card class="flex flex-col">
  <CardHeader class="flex flex-row items-start justify-between gap-3 space-y-0">
    <div>
      <CardTitle>Claude usage</CardTitle>
      <CardDescription>
        {#if source}
          via <span class="font-mono">{source}</span>
        {:else}
          Reported by Claude Code's own statusline
        {/if}
      </CardDescription>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        onclick={() => (historyOpen = true)}
        disabled={!$history.data}
        aria-label="View history"
        title="View history"
      >
        <LineChart class="h-4 w-4" />
        <span class="hidden sm:inline">History</span>
      </Button>
      <Button
        variant="outline"
        size="sm"
        onclick={handleRefresh}
        disabled={$usage.isFetching}
        aria-label="Refresh Claude usage"
      >
        <RefreshCw class="h-4 w-4 {$usage.isFetching ? 'animate-spin' : ''}" />
        <span class="hidden sm:inline">Refresh</span>
      </Button>
    </div>
  </CardHeader>
  <CardContent class="flex flex-1 flex-col gap-4">
    {#if $usage.isPending}
      <div class="space-y-3">
        <Skeleton class="h-3 w-1/3" />
        <Skeleton class="h-2.5 w-full" />
        <Skeleton class="h-3 w-1/3" />
        <Skeleton class="h-2.5 w-full" />
        <Skeleton class="h-10 w-full" />
      </div>
    {:else if $usage.isError && !snapshot}
      <Alert variant="destructive">
        <AlertTitle>Could not load Claude usage</AlertTitle>
        <AlertDescription>{$usage.error?.message ?? "Unknown error"}</AlertDescription>
      </Alert>
    {:else if !snapshot}
      <div class="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
        No usage reported yet — run <span class="font-mono">clx</span> on a host to start reporting.
      </div>
    {:else}
      <div class="space-y-3">
        <UsageMeter
          label="5-hour window"
          valueLabel={fiveHourPercent === null ? "—" : `${Math.round(fiveHourPercent)}%`}
          usedPercent={fiveHourPercent ?? 0}
        />
        <UsageMeter
          label="Weekly window"
          valueLabel={sevenDayPercent === null ? "—" : `${Math.round(sevenDayPercent)}%`}
          usedPercent={sevenDayPercent ?? 0}
        />
      </div>

      <div class="flex items-end justify-between gap-3 pt-1">
        <div class="min-w-0 text-xs text-muted-foreground">
          {#if fetchedAt}
            Updated {relativeTime(fetchedAt)}
          {:else}
            No report recorded
          {/if}
        </div>
        <div class="text-primary">
          <Sparkline points={sparkPoints} width={140} height={36} min={0} max={100} />
        </div>
      </div>
    {/if}
  </CardContent>
</Card>

<Dialog bind:open={historyOpen}>
  <DialogContent class="max-w-4xl">
    <DialogHeader>
      <DialogTitle>Claude usage history</DialogTitle>
      <DialogDescription>
        Quota windows over the last {$history.data?.days ?? 60} days. Scroll-wheel zoom, drag to pan.
      </DialogDescription>
    </DialogHeader>
    {#if $history.isPending}
      <Skeleton class="h-72 w-full" />
    {:else if $history.isError}
      <Alert variant="destructive">
        <AlertTitle>Failed to load history</AlertTitle>
        <AlertDescription>{$history.error?.message ?? "Unknown error"}</AlertDescription>
      </Alert>
    {:else if chartSeries.length === 0}
      <p class="py-12 text-center text-sm text-muted-foreground">No history points recorded yet.</p>
    {:else}
      <TrendChart series={chartSeries} height={320} percent timeUnit="day" />
    {/if}
  </DialogContent>
</Dialog>
