<script lang="ts">
  /**
   * Overview. First what is waiting on the operator (Needs you), then three
   * tabs, one question each: how much quota is left (Provider), what is
   * installed (Engines), and whether logins still verify (Runner).
   */
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import { PageShell, Section, StateBlock, StatStrip, Timestamp, type Stat } from "$lib/components/page";
  import { ENGINE_META } from "$lib/constants/engines";
  import { Button } from "$lib/components/ui/button";
  import * as Tabs from "$lib/components/ui/tabs";
  import { accountsQuery } from "$lib/api/accounts";
  import { createRunnerStateQuery } from "$lib/api/runner";
  import { overviewQuery } from "$lib/api/overview";
  import OnboardingNotice from "$lib/components/dashboard/OnboardingNotice.svelte";
  import NeedsYou from "$lib/components/dashboard/NeedsYou.svelte";
  import UsageTable from "$lib/components/dashboard/UsageTable.svelte";
  import EngineTable from "$lib/components/dashboard/EngineTable.svelte";
  import RunnerStatus from "$lib/components/dashboard/RunnerStatus.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Plus from "@lucide/svelte/icons/plus";
  import { loadFailure } from "$lib/api/access-denied";
  import { engineActiveQuery } from "$lib/api/settings";
  import { useFleetEngines } from "$lib/engines/fleet-engines";

  const fleet = useFleetEngines();
  // Same key as the fleet store, so Refresh re-reads which engines belong to the fleet.
  const engineState = engineActiveQuery();
  const overview = overviewQuery();
  const accounts = accountsQuery();
  const runner = createRunnerStateQuery();

  // The tab lives in the URL so a reload or a shared link lands on the same one.
  const TABS = ["provider", "engines", "runner"];
  const tab = $derived(TABS.find((id) => id === page.url.searchParams.get("tab")) ?? "provider");
  function selectTab(id: string) {
    // Other view state in the address (the expanded account groups) survives a tab switch.
    const params = new URLSearchParams(page.url.searchParams);
    if (id === "provider") params.delete("tab");
    else params.set("tab", id);
    const query = params.toString();
    void goto(query ? `?${query}` : page.url.pathname, { replaceState: true, noScroll: true, keepFocus: true });
  }

  // Only the operator's own Refresh says "Refreshing…". Live events (host heartbeats, account
  // updates) refetch in the background about every second on a busy fleet; showing each one
  // made the freshness line and the button flicker. The timestamp moves when new data lands.
  let refreshing = $state(false);
  // Freshness of what the page shows: the older of the two snapshots (0 = never loaded).
  const updatedAt = $derived(
    $overview.dataUpdatedAt && $accounts.dataUpdatedAt ? Math.min($overview.dataUpdatedAt, $accounts.dataUpdatedAt) : 0,
  );
  async function refresh() {
    refreshing = true;
    try {
      await Promise.all([$overview.refetch(), $accounts.refetch(), $runner.refetch(), $engineState.refetch()]);
    } finally {
      refreshing = false;
    }
  }

  const accountRows = $derived($accounts.data?.accounts);

  // Unavailable is not zero: a number appears only once its query has answered.
  const stats = $derived.by<Stat[]>(() => {
    const hostCount = $overview.data?.totals?.hosts;
    const rows = accountRows?.filter((account) => $fleet.isEnabled(account.engine));
    const paused = rows?.filter((account) => account.state !== "enabled").length ?? 0;
    const perEngine = rows
      ? $fleet.enabled.map((engine) => ({ engine, count: rows.filter((account) => account.engine === engine).length }))
          .filter((entry) => entry.count > 0)
          .map((entry) => `${ENGINE_META[entry.engine].label} ${entry.count}`)
          .join(" · ")
      : "";
    const items: Stat[] = [
      { label: hostCount === 1 ? "host" : "hosts", value: hostCount ?? "–", href: `${base}/hosts` },
      {
        label: $fleet.known
          ? rows?.length === 1 ? "account for enabled engines" : "accounts for enabled engines"
          : rows?.length === 1 ? "stored account" : "stored accounts",
        value: rows?.length ?? "–",
        href: `${base}/accounts`,
        hint: perEngine || undefined,
      },
    ];
    if (paused > 0) items.push({ label: "paused or being removed", value: paused, tone: "warning", href: `${base}/accounts` });
    return items;
  });
</script>

<PageShell title="Overview" description="What needs you, then provider usage, engines and login verification.">
  {#snippet actions()}
    {#if updatedAt}
      <span class="text-body-sm text-muted-foreground">{#if refreshing}Refreshing…{:else}Updated <Timestamp value={updatedAt} live />{/if}</span>
    {/if}
    <Button variant="outline" onclick={refresh} disabled={refreshing}>
      <RefreshCw class="h-4 w-4 {refreshing ? 'animate-spin' : ''}" /> Refresh
    </Button>
    <Button href={`${base}/hosts?dialog=new-host`}><Plus class="h-4 w-4" /> Add host</Button>
  {/snippet}

  <div class="flex flex-col gap-6">
    {#if $overview.isError}
      <StateBlock
        state="error"
        cause={$overview.error}
        message={`${$overview.data ? "Overview could not refresh; showing the last snapshot" : "Could not load fleet overview"}: ${$overview.error?.message || "the server returned no reason"}`}
        onRetry={() => $overview.refetch()}
      />
    {/if}

    <NeedsYou />

    <OnboardingNotice />

    <StatStrip items={stats} variant="tiles" />

    <Tabs.Root value={tab} onValueChange={selectTab} class="flex flex-col gap-4">
      <Tabs.List class="w-fit">
        <Tabs.Trigger value="provider">Provider</Tabs.Trigger>
        <Tabs.Trigger value="engines">Engines</Tabs.Trigger>
        <Tabs.Trigger value="runner">Runner</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="provider">
    <Section id="usage" title="Provider usage" description="Quota windows for enabled engines. An engine with several accounts is one group, judged as a pool; expand it for each account. Retained accounts remain available in Accounts.">
      {#snippet actions()}<Button size="sm" variant="outline" href={`${base}/accounts`}>Manage accounts</Button>{/snippet}
      <UsageTable
        accounts={accountRows}
        loading={$accounts.isPending}
        error={$accounts.isError && !accountRows ? loadFailure($accounts.error, "Could not load provider accounts") : null}
        onRetry={() => $accounts.refetch()}
      />
      {#if $accounts.isError && accountRows}
        <p class="mt-2 text-body-sm text-warning" role="alert">
          Could not refresh accounts, showing the last result.
          <Button size="sm" variant="outline" class="ml-1" onclick={() => $accounts.refetch()} disabled={$accounts.isFetching}>Retry accounts</Button>
        </p>
      {/if}
    </Section>
      </Tabs.Content>

      <Tabs.Content value="engines">
    <Section id="engines" title="Engines" description="Installed CLI versions and upstream releases for enabled engines. All engine switches remain under Configure engines.">
      {#snippet actions()}<Button size="sm" variant="outline" href={`${base}/engines`}>Configure engines</Button>{/snippet}
      <EngineTable overview={$overview.data} loading={$overview.isPending} />
    </Section>
      </Tabs.Content>

      <Tabs.Content value="runner">
    <Section id="runner" title="Verification runner" description="Login verification for enabled engines before credentials are stored.">
      <RunnerStatus />
    </Section>
      </Tabs.Content>
    </Tabs.Root>
  </div>
</PageShell>
