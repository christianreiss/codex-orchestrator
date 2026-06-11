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
  import LineChart from "@lucide/svelte/icons/line-chart";
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
  import Sparkline from "$lib/components/dashboard/Sparkline.svelte";
  import TrendChart from "$lib/components/dashboard/TrendChart.svelte";
  import {
    claudeVersionQuery,
    claudeHistoryQuery,
    flattenClaudeHistory,
  } from "$lib/api/usage";
  import { formatTokens, relativeTime } from "$lib/utils/format";

  const versionQ = claudeVersionQuery();
  const history7d = claudeHistoryQuery("7d", "daily");
  const history30d = claudeHistoryQuery("30d", "daily");

  let historyOpen = $state(false);

  const flat7d = $derived(flattenClaudeHistory($history7d.data));
  const flat30d = $derived(flattenClaudeHistory($history30d.data));

  const totalLast7d = $derived(flat7d.reduce((acc, p) => acc + p.value, 0));
  const peakLast7d = $derived(flat7d.reduce((acc, p) => Math.max(acc, p.value), 0));

  // Per-model breakdown for the chart modal.
  const modelSeries = $derived.by(() => {
    const rows = $history30d.data ?? [];
    if (rows.length === 0) return [];
    const byModel = new Map<string, Array<{ x: string; y: number }>>();
    for (const row of rows) {
      const series = byModel.get(row.model) ?? [];
      series.push({ x: row.bucket, y: row.total_tokens });
      byModel.set(row.model, series);
    }
    return [...byModel.entries()]
      .map(([label, data]) => ({
        label,
        data: data.sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0)),
      }))
      .sort((a, b) => {
        const aTot = a.data.reduce((s, p) => s + p.y, 0);
        const bTot = b.data.reduce((s, p) => s + p.y, 0);
        return bTot - aTot;
      });
  });

  const versionLabel = $derived($versionQ.data?.client_version ?? null);
  const versionUpdated = $derived($versionQ.data?.client_version_lock_updated_at ?? null);
</script>

<Card class="flex flex-col">
  <CardHeader class="flex flex-row items-start justify-between gap-3 space-y-0">
    <div class="min-w-0">
      <CardTitle>Claude usage</CardTitle>
      <CardDescription>
        {#if versionLabel}
          <span class="font-mono">{versionLabel}</span>
          {#if versionUpdated}
            · updated {relativeTime(versionUpdated)}
          {/if}
        {:else if $versionQ.isPending}
          loading version…
        {:else}
          no fleet version set
        {/if}
      </CardDescription>
    </div>
    <Button
      variant="ghost"
      size="sm"
      onclick={() => (historyOpen = true)}
      disabled={!$history30d.data}
      aria-label="View history"
      title="View history"
    >
      <LineChart class="h-4 w-4" />
      <span class="hidden sm:inline">History</span>
    </Button>
  </CardHeader>
  <CardContent class="flex flex-1 flex-col gap-4">
    {#if $history7d.isPending}
      <div class="space-y-3">
        <Skeleton class="h-3 w-1/3" />
        <Skeleton class="h-12 w-full" />
        <Skeleton class="h-3 w-1/3" />
      </div>
    {:else if $history7d.isError && flat7d.length === 0}
      <Alert variant="destructive">
        <AlertTriangle class="h-4 w-4" />
        <AlertTitle>Could not load Claude usage</AlertTitle>
        <AlertDescription>{$history7d.error?.message ?? "Unknown error"}</AlertDescription>
      </Alert>
    {:else if flat7d.length === 0}
      <div class="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
        No Claude tokens recorded yet — connect a Claude-enabled host to start tracking.
      </div>
    {:else}
      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-md border bg-muted/20 p-3">
          <div class="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">7-day tokens</div>
          <div class="mt-1 text-xl font-semibold tabular-nums">{formatTokens(totalLast7d)}</div>
        </div>
        <div class="rounded-md border bg-muted/20 p-3">
          <div class="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">Peak day</div>
          <div class="mt-1 text-xl font-semibold tabular-nums">{formatTokens(peakLast7d)}</div>
        </div>
      </div>
      <div class="flex items-end justify-between gap-3">
        <div class="min-w-0 text-xs text-muted-foreground">
          Last 7 days, all models
        </div>
        <div class="text-red-600 dark:text-red-500">
          <Sparkline points={flat7d} width={160} height={40} min={0} />
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
        Tokens by model over the last 30 days. Scroll-wheel zoom, drag to pan.
      </DialogDescription>
    </DialogHeader>
    {#if $history30d.isPending}
      <Skeleton class="h-72 w-full" />
    {:else if $history30d.isError}
      <Alert variant="destructive">
        <AlertTitle>Failed to load history</AlertTitle>
        <AlertDescription>{$history30d.error?.message ?? "Unknown error"}</AlertDescription>
      </Alert>
    {:else if modelSeries.length === 0}
      <p class="py-12 text-center text-sm text-muted-foreground">
        No Claude usage recorded in the last 30 days.
      </p>
    {:else}
      <TrendChart series={modelSeries} height={320} timeUnit="day" />
    {/if}
  </DialogContent>
</Dialog>
