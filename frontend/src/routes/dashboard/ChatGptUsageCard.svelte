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
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
  import UsageMeter from "$lib/components/dashboard/UsageMeter.svelte";
  import Sparkline from "$lib/components/dashboard/Sparkline.svelte";
  import TrendChart from "$lib/components/dashboard/TrendChart.svelte";
  import {
    chatgptUsageQuery,
    chatgptHistoryQuery,
    chatgptRefreshMutation,
    pickPrimaryChatgptSeries,
    chatgptQuotaRows,
    chatgptSeriesLabel,
    type ChatGptUsageSummary,
  } from "$lib/api/usage";
  import { toast } from "svelte-sonner";
  import { relativeTime } from "$lib/utils/format";

  const usage = chatgptUsageQuery();
  const history = chatgptHistoryQuery(60);
  const refresh = chatgptRefreshMutation();

  let historyOpen = $state(false);

  const summary = $derived.by<ChatGptUsageSummary | null>(() => {
    const data = $usage.data;
    if (!data) return null;
    const snapshot = (data.snapshot ?? data) as Record<string, unknown> | null;
    if (!snapshot || typeof snapshot !== "object") return null;
    return snapshot as ChatGptUsageSummary;
  });

  const planType = $derived(summary?.plan_type ?? "—");
  const fetchedAt = $derived(summary?.fetched_at ?? null);
  const rateLimited = $derived(summary?.rate_limit_reached === true);

  // One bar per window chatgpt.com actually reported — never one per slot.
  // The provider stopped sending the normal lane's secondary window on
  // 2026-07-11, and a meter per slot drew that absent window as a second
  // "Weekly window" bar reading "—". Labels come from each window's own
  // limit_seconds rather than its primary/secondary position.
  const quotaRows = $derived(chatgptQuotaRows(summary));

  const cached = $derived(($usage.data as { cached?: boolean } | undefined)?.cached === true);

  const primarySeries = $derived(pickPrimaryChatgptSeries($history.data));
  const sparkPoints = $derived(
    (primarySeries?.points ?? []).map((p) => ({ ts: p.ts, value: p.value })),
  );

  // Build datasets for the full-history modal. Series with no points are
  // dropped rather than charted as an empty legend entry — a lane the
  // provider has stopped reporting should leave the chart, not linger in it.
  const chartSeries = $derived(
    ($history.data?.series ?? [])
      .filter((s) => s.points.length > 0)
      .map((s) => ({
        label: chatgptSeriesLabel(s),
        data: s.points.map((p) => ({ x: p.ts, y: p.value })),
      })),
  );

  function handleRefresh() {
    $refresh.mutate(undefined, {
      onSuccess: () => toast.success("ChatGPT usage refreshed"),
      onError: (err) => toast.error(err.message || "Refresh failed"),
    });
  }
</script>

<Card class="flex flex-col">
  <CardHeader class="flex flex-row items-start justify-between gap-3 space-y-0">
    <div>
      <CardTitle>ChatGPT usage</CardTitle>
      <CardDescription>
        {#if planType && planType !== "—"}
          Plan <span class="font-mono">{planType}</span>
        {/if}
        {#if cached}
          · cached
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
        disabled={$refresh.isPending}
        aria-label="Refresh ChatGPT usage"
      >
        <RefreshCw class="h-4 w-4 {$refresh.isPending ? 'animate-spin' : ''}" />
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
    {:else if $usage.isError && !summary}
      <Alert variant="destructive">
        <AlertTriangle class="h-4 w-4" />
        <AlertTitle>Could not load ChatGPT usage</AlertTitle>
        <AlertDescription>{$usage.error?.message ?? "Unknown error"}</AlertDescription>
      </Alert>
    {:else if !summary}
      <div class="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
        No usage recorded yet — connect your first host or click Refresh.
      </div>
    {:else}
      {#if quotaRows.length === 0}
        <div class="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          No quota windows reported in the latest snapshot.
        </div>
      {:else}
        <div class="space-y-3">
          {#each quotaRows as row (row.key)}
            <UsageMeter
              label={row.label}
              valueLabel={`${Math.round(row.usedPercent)}%`}
              usedPercent={row.usedPercent}
              cachedPercent={cached ? row.usedPercent : 0}
            />
          {/each}
        </div>
      {/if}

      {#if rateLimited}
        <Alert variant="warning">
          <AlertTitle>Rate limit reached</AlertTitle>
          <AlertDescription>
            Codex requests will be throttled until
            {#if summary?.next_eligible_at}<span class="font-mono">{relativeTime(summary.next_eligible_at)}</span>{:else}
              the window resets
            {/if}.
          </AlertDescription>
        </Alert>
      {/if}

      <div class="flex items-end justify-between gap-3 pt-1">
        <div class="min-w-0 text-xs text-muted-foreground">
          {#if fetchedAt}
            Updated {relativeTime(fetchedAt)}
          {:else}
            No fetch recorded
          {/if}
        </div>
        <div class="text-primary">
          <Sparkline
            points={sparkPoints}
            width={140}
            height={36}
            min={0}
            max={100}
          />
        </div>
      </div>
    {/if}
  </CardContent>
</Card>

<Dialog bind:open={historyOpen}>
  <DialogContent class="max-w-4xl">
    <DialogHeader>
      <DialogTitle>ChatGPT usage history</DialogTitle>
      <DialogDescription>
        Quota lanes over the last {$history.data?.days ?? 60} days. Scroll-wheel zoom, drag to pan.
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
      <p class="py-12 text-center text-sm text-muted-foreground">
        No history points recorded yet.
      </p>
    {:else}
      <TrendChart series={chartSeries} height={320} percent timeUnit="day" />
    {/if}
  </DialogContent>
</Dialog>
