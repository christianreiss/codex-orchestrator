<script lang="ts">
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import StatCard from "./StatCard.svelte";
  import ChatGptUsageCard from "./ChatGptUsageCard.svelte";
  import RunnerCard from "$lib/components/dashboard/RunnerCard.svelte";
  import DashboardAlerts from "./DashboardAlerts.svelte";
  import { overviewQuery } from "$lib/api/overview";
  import Server from "@lucide/svelte/icons/server";
  import Package from "@lucide/svelte/icons/package";
  import Bot from "@lucide/svelte/icons/bot";

  const overview = overviewQuery();

  /**
   * Active host count is not exposed directly on /admin/overview; derive it
   * from `last_refresh` recency vs the configured inactivity window. We do
   * not know the inactivity window without an extra round-trip, so we use a
   * conservative 7-day default and fall back to the total if no signal
   * exists.
   */
  const stats = $derived.by(() => {
    const data = $overview.data;
    if (!data) return null;
    const hosts = data.totals?.hosts ?? 0;
    const lastRefresh = data.last_refresh ?? null;
    return { hosts, lastRefresh };
  });

  const currentVersion = $derived(
    ($overview.data?.versions?.client_version as string | null | undefined) ??
      ($overview.data?.versions?.cdx_version as string | null | undefined) ??
      null,
  );

  const claudeVersion = $derived(
    ($overview.data?.versions?.claude_version as string | null | undefined) ?? null,
  );

  const refreshHint = $derived.by(() => {
    if (!$overview.data) return null;
    const lr = $overview.data.last_refresh;
    if (!lr) return "no refreshes yet";
    const ts = new Date(lr).getTime();
    if (Number.isNaN(ts)) return null;
    const age = Date.now() - ts;
    const hours = age / 3_600_000;
    if (hours < 1) return "<1h since last refresh";
    if (hours < 24) return `${Math.round(hours)}h since last refresh`;
    return `${Math.round(hours / 24)}d since last refresh`;
  });
</script>

<PageHeader title="Dashboard" subtitle="Fleet overview" />

<div class="flex flex-col gap-6">
  <!-- Fleet + version stat cards -->
  <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
    <StatCard
      label="Hosts"
      value={stats?.hosts ?? 0}
      hint={refreshHint}
      loading={$overview.isPending}
    >
      {#snippet icon()}
        <Server class="h-4 w-4" />
      {/snippet}
    </StatCard>
    <StatCard
      label="Codex version"
      value={currentVersion ?? "—"}
      loading={$overview.isPending}
    >
      {#snippet icon()}
        <Package class="h-4 w-4" />
      {/snippet}
    </StatCard>
    <StatCard
      label="Claude version"
      value={claudeVersion ?? "—"}
      loading={$overview.isPending}
    >
      {#snippet icon()}
        <Bot class="h-4 w-4" />
      {/snippet}
    </StatCard>
  </div>

  <!-- Alerts row -->
  <DashboardAlerts {currentVersion} />

  <!-- Usage + runner cards -->
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
    <ChatGptUsageCard />
    <RunnerCard />
  </div>
</div>
