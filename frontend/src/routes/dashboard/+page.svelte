<script lang="ts">
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import StatCard from "./StatCard.svelte";
  import ChatGptUsageCard from "./ChatGptUsageCard.svelte";
  import ClaudeUsageCard from "./ClaudeUsageCard.svelte";
  import RunnerCard from "$lib/components/dashboard/RunnerCard.svelte";
  import DashboardAlerts from "./DashboardAlerts.svelte";
  import { Alert, AlertTitle, AlertDescription } from "$lib/components/ui/alert";
  import { engineInstallCounts, overviewQuery } from "$lib/api/overview";
  import Server from "@lucide/svelte/icons/server";
  import Package from "@lucide/svelte/icons/package";
  import Bot from "@lucide/svelte/icons/bot";
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
  import Activity from "@lucide/svelte/icons/activity";
  import Plus from "@lucide/svelte/icons/plus";
  import { Button } from "$lib/components/ui/button";
  import { base } from "$app/paths";
  import OnboardingCard from "./OnboardingCard.svelte";

  const overview = overviewQuery();

  /** The endpoint exposes the fleet total and its latest refresh directly. */
  const stats = $derived.by(() => {
    const data = $overview.data;
    if (!data) return null;
    const hosts = data.totals?.hosts ?? 0;
    const lastRefresh = data.last_refresh ?? null;
    return { hosts, lastRefresh };
  });

  const installs = $derived(engineInstallCounts($overview.data?.version_distribution));

  // Live upstream latest versions (GitHub for Codex, npm for Claude), surfaced
  // by /admin/overview from the 1h-cached availableClientVersion lookup.
  const codexLatest = $derived($overview.data?.versions?.cdx_version_available ?? null);
  const claudeLatest = $derived($overview.data?.versions?.claude_version_available ?? null);

  // `stale` means the upstream fetch has been failing: the API keeps serving
  // the expired cache rather than breaking updates, so an ageing check time is
  // the only sign the whole fleet is being handed an old target.
  function checkedHint(iso?: string | null, stale?: boolean): string | null {
    if (!iso) return null;
    const ts = new Date(iso).getTime();
    if (Number.isNaN(ts)) return null;
    const mins = (Date.now() - ts) / 60_000;
    const prefix = stale ? "stale — checked" : "checked";
    if (mins < 1) return `${prefix} just now`;
    if (mins < 60) return `${prefix} ${Math.round(mins)}m ago`;
    const hours = mins / 60;
    if (hours < 24) return `${prefix} ${Math.round(hours)}h ago`;
    return `${prefix} ${Math.round(hours / 24)}d ago`;
  }
  const codexChecked = $derived(
    checkedHint(
      $overview.data?.versions?.cdx_version_checked_at,
      $overview.data?.versions?.cdx_version_stale,
    ),
  );
  const claudeChecked = $derived(
    checkedHint(
      $overview.data?.versions?.claude_version_checked_at,
      $overview.data?.versions?.claude_version_stale,
    ),
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

<PageHeader
  title="Overview"
  subtitle="Fleet health, upstream releases, provider usage, and runner readiness at a glance."
>
  {#snippet actions()}
    <Button variant="outline" href={`${base}/logs/events`}>
      <Activity class="h-4 w-4" /> Activity
    </Button>
    <Button href={`${base}/hosts?dialog=new-host`}>
      <Plus class="h-4 w-4" /> Register host
    </Button>
  {/snippet}
</PageHeader>

<div class="flex flex-col gap-6">
  <OnboardingCard />
  <!-- Fleet + latest-version stat cards -->
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
    <StatCard
      label="Hosts"
      value={stats?.hosts ?? 0}
      hint={refreshHint}
      loading={$overview.isPending}
    >
      {#snippet icon()}
        <Server class="h-4 w-4" />
      {/snippet}
      {#snippet breakdown()}
        <dl
          class="grid grid-cols-2 divide-x divide-border/70 text-right leading-none"
          aria-label="Reported installations by engine"
          title="Hosts that reported an installed CLI version"
        >
          <div class="min-w-14 pr-2">
            <dt class="flex items-center justify-end gap-1 text-[10px] font-medium text-muted-foreground">
              <span class="h-1.5 w-1.5 rounded-full bg-persona-codex" aria-hidden="true"></span>
              Codex
            </dt>
            <dd class="mt-1 text-sm font-semibold tabular-nums">{installs?.codex ?? "—"}</dd>
          </div>
          <div class="min-w-14 pl-2">
            <dt class="flex items-center justify-end gap-1 text-[10px] font-medium text-muted-foreground">
              <span class="h-1.5 w-1.5 rounded-full bg-persona-claude" aria-hidden="true"></span>
              Claude
            </dt>
            <dd class="mt-1 text-sm font-semibold tabular-nums">{installs?.claude ?? "—"}</dd>
          </div>
        </dl>
      {/snippet}
    </StatCard>
    <StatCard
      label="Codex latest"
      value={codexLatest ?? "—"}
      hint={codexChecked}
      loading={$overview.isPending}
    >
      {#snippet icon()}
        <Package class="h-4 w-4" />
      {/snippet}
    </StatCard>
    <StatCard
      label="Claude latest"
      value={claudeLatest ?? "—"}
      hint={claudeChecked}
      loading={$overview.isPending}
    >
      {#snippet icon()}
        <Bot class="h-4 w-4" />
      {/snippet}
    </StatCard>
  </div>

  <!-- Alerts row -->
  <DashboardAlerts />

  <!-- Usage + runner cards -->
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
    <ChatGptUsageCard />
    <ClaudeUsageCard />
    <RunnerCard />
  </div>
</div>
