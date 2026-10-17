<script lang="ts">
  /**
   * Overview. Exceptions first: what needs attention and where to fix it, then
   * one line of fleet numbers, provider usage, engines, and the runner.
   */
  import { base } from "$app/paths";
  import { PageShell, Section, StatStrip, StateBlock, type Stat } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { accountsQuery } from "$lib/api/accounts";
  import { hostsListQuery, hostStatusKind } from "$lib/api/hosts";
  import { createRunnerStateQuery } from "$lib/api/runner";
  import { insecureApprovalsPendingQuery, overviewQuery } from "$lib/api/overview";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { ENGINE_META } from "$lib/constants/engines";
  import { relativeTime } from "$lib/utils/format";
  import AttentionList from "$lib/components/dashboard/AttentionList.svelte";
  import OnboardingNotice from "$lib/components/dashboard/OnboardingNotice.svelte";
  import UsageTable from "$lib/components/dashboard/UsageTable.svelte";
  import EngineTable from "$lib/components/dashboard/EngineTable.svelte";
  import RunnerStatus from "$lib/components/dashboard/RunnerStatus.svelte";
  import { buildAttention } from "$lib/components/dashboard/attention";
  import { hostFindings } from "$lib/components/dashboard/host-findings";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Plus from "@lucide/svelte/icons/plus";

  const overview = overviewQuery();
  const accounts = accountsQuery();
  const hosts = hostsListQuery();
  const approvals = insecureApprovalsPendingQuery();
  const runner = createRunnerStateQuery();
  const fleet = useFleetEngines();

  const fetching = $derived($overview.isFetching || $accounts.isFetching || $hosts.isFetching || $approvals.isFetching);
  function refresh() {
    void Promise.all([$overview.refetch(), $accounts.refetch(), $hosts.refetch(), $approvals.refetch(), $runner.refetch()]);
  }

  const hostRows = $derived($hosts.data?.hosts ?? []);
  const accountRows = $derived($accounts.data?.accounts);
  const disabledLabels = $derived($fleet.disabled.map((engine) => ENGINE_META[engine].label));

  const staleChecks = $derived(
    (["codex", "claude", "grok"] as const)
      .filter((engine) => $overview.data?.versions?.[`${engine === "codex" ? "cdx" : engine}_version_stale`] === true)
      .map((engine) => ENGINE_META[engine].label),
  );

  const attention = $derived(
    buildAttention({
      hosts: $hosts.data ? hostFindings(hostRows, $fleet.disabled) : null,
      pendingApprovals: $approvals.isError ? null : ($approvals.data?.requests?.length ?? 0),
      accounts: accountRows ?? null,
      runner: $runner.data?.runner ?? null,
      disabledEngines: disabledLabels,
      allEnginesDisabled: $fleet.enabled.length === 0 && $fleet.disabled.length > 0,
      staleReleaseChecks: staleChecks,
    }),
  );
  const sourcesLoading = $derived($hosts.isPending || $accounts.isPending || $runner.isPending);

  const stats = $derived.by<Stat[] | null>(() => {
    const total = $hosts.data ? hostRows.length : $overview.data?.totals?.hosts;
    if (total === undefined) return null;
    const online = hostRows.filter((host) => hostStatusKind(host) === "online").length;
    const sessions = (accountRows ?? []).reduce((sum, account) => sum + account.sessions.length, 0);
    const alerts = attention.filter((item) => item.tone !== "info").length;
    const refreshed = $overview.data?.last_refresh;
    return [
      { label: "hosts online", value: $hosts.data ? `${online} / ${total}` : total, href: `${base}/hosts`, tone: $hosts.data && online < total ? "warning" : "default" },
      { label: "active agents", value: accountRows ? sessions : "—", hint: "Agent sessions currently running on a provider account" },
      { label: "accounts", value: accountRows ? accountRows.length : "—", href: `${base}/accounts` },
      { label: "need attention", value: alerts, tone: alerts ? "danger" : "success" },
      ...(refreshed ? [{ label: "last refresh", value: relativeTime(refreshed), hint: "Most recent credential refresh across the fleet" } satisfies Stat] : []),
    ];
  });
</script>

<PageShell title="Overview" description="What needs attention across the fleet, then how it is doing.">
  {#snippet actions()}
    <Button variant="outline" onclick={refresh} disabled={fetching}>
      <RefreshCw class="h-4 w-4 {fetching ? 'animate-spin' : ''}" /> Refresh
    </Button>
    <Button href={`${base}/hosts?dialog=new-host`}><Plus class="h-4 w-4" /> Add host</Button>
  {/snippet}

  <div class="flex flex-col gap-6">
    {#if $overview.isError}
      <StateBlock
        state="error"
        message={`${$overview.data ? "Overview could not refresh; showing the last snapshot" : "Could not load fleet overview"}: ${$overview.error?.message ?? "unknown error"}`}
        onRetry={() => $overview.refetch()}
      />
    {/if}

    <AttentionList items={attention} loading={sourcesLoading} />

    <OnboardingNotice />

    {#if stats}
      <StatStrip items={stats} />
    {:else if $overview.isPending}
      <StateBlock state="loading" rows={1} />
    {/if}

    <Section id="usage" title="Provider usage" description="Quota windows reported by each connected account.">
      {#snippet actions()}<Button size="sm" variant="outline" href={`${base}/accounts`}>Manage accounts</Button>{/snippet}
      <UsageTable
        accounts={accountRows}
        loading={$accounts.isPending}
        error={$accounts.isError && !accountRows ? `Could not load provider accounts: ${$accounts.error?.message ?? "unknown error"}` : null}
        onRetry={() => $accounts.refetch()}
      />
      {#if $accounts.isError && accountRows}
        <p class="mt-2 text-body-sm text-warning" role="alert">
          Could not refresh accounts, showing the last result.
          <Button size="sm" variant="outline" class="ml-1" onclick={() => $accounts.refetch()} disabled={$accounts.isFetching}>Retry accounts</Button>
        </p>
      {/if}
    </Section>

    <Section id="engines" title="Engines" description="Installed CLI versions reported by hosts, and the latest upstream release.">
      {#snippet actions()}<Button size="sm" variant="outline" href={`${base}/engines`}>Configure engines</Button>{/snippet}
      <EngineTable overview={$overview.data} loading={$overview.isPending} />
    </Section>

    <Section id="runner" title="Verification runner" description="Checks provider logins with the provider before they are stored.">
      <RunnerStatus />
    </Section>
  </div>
</PageShell>
