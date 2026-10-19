<script lang="ts">
  /**
   * Overview. Three tabs, one question each: how much quota is left (Provider),
   * what is installed (Engines), and whether logins still verify (Runner).
   */
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import { PageShell, Section, StateBlock } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import * as Tabs from "$lib/components/ui/tabs";
  import { accountsQuery } from "$lib/api/accounts";
  import { createRunnerStateQuery } from "$lib/api/runner";
  import { overviewQuery } from "$lib/api/overview";
  import OnboardingNotice from "$lib/components/dashboard/OnboardingNotice.svelte";
  import UsageTable from "$lib/components/dashboard/UsageTable.svelte";
  import EngineTable from "$lib/components/dashboard/EngineTable.svelte";
  import RunnerStatus from "$lib/components/dashboard/RunnerStatus.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Plus from "@lucide/svelte/icons/plus";

  const overview = overviewQuery();
  const accounts = accountsQuery();
  const runner = createRunnerStateQuery();

  // The tab lives in the URL so a reload or a shared link lands on the same one.
  const TABS = ["provider", "engines", "runner"];
  const tab = $derived(TABS.find((id) => id === page.url.searchParams.get("tab")) ?? "provider");
  function selectTab(id: string) {
    void goto(id === "provider" ? page.url.pathname : `?tab=${id}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  const fetching = $derived($overview.isFetching || $accounts.isFetching);
  function refresh() {
    void Promise.all([$overview.refetch(), $accounts.refetch(), $runner.refetch()]);
  }

  const accountRows = $derived($accounts.data?.accounts);
</script>

<PageShell title="Overview" description="Provider quota, installed engines and login verification.">
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

    <OnboardingNotice />

    <Tabs.Root value={tab} onValueChange={selectTab} class="flex flex-col gap-4">
      <Tabs.List class="w-fit">
        <Tabs.Trigger value="provider">Provider</Tabs.Trigger>
        <Tabs.Trigger value="engines">Engines</Tabs.Trigger>
        <Tabs.Trigger value="runner">Runner</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="provider">
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
      </Tabs.Content>

      <Tabs.Content value="engines">
    <Section id="engines" title="Engines" description="Installed CLI versions reported by hosts, and the latest upstream release.">
      {#snippet actions()}<Button size="sm" variant="outline" href={`${base}/engines`}>Configure engines</Button>{/snippet}
      <EngineTable overview={$overview.data} loading={$overview.isPending} />
    </Section>
      </Tabs.Content>

      <Tabs.Content value="runner">
    <Section id="runner" title="Verification runner" description="Checks provider logins with the provider before they are stored.">
      <RunnerStatus />
    </Section>
      </Tabs.Content>
    </Tabs.Root>
  </div>
</PageShell>
