<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { PageShell, StatStrip, Toolbar, DataTable } from "$lib/components/page";
  import * as Table from "$lib/components/ui/table";
  import { Button } from "$lib/components/ui/button";
  import { hostsListQuery } from "$lib/api/hosts";
  import { accountsApi, accountsKeys, accountsQuery, type ProviderAccount } from "$lib/api/accounts";
  import { authStore } from "$lib/stores/auth";
  import { ENGINE_META, isEngine, type Engine } from "$lib/constants/engines";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import AccountRow from "$lib/components/accounts/AccountRow.svelte";
  import AccountDialogs, { type AccountDialog } from "$lib/components/accounts/AccountDialogs.svelte";
  import AccountPolicy from "$lib/components/accounts/AccountPolicy.svelte";
  import AccountScopes from "$lib/components/accounts/AccountScopes.svelte";
  import EngineFilter from "$lib/components/accounts/EngineFilter.svelte";
  import { matchesSearch, nearQuotaCounted, needsAttention, poolCoveredIds, sortAccounts, NEAR_QUOTA_PERCENT } from "$lib/components/accounts/account-state";
  import { UrlFilters } from "$lib/utils/url-filters.svelte";
  import { base } from "$app/paths";

  const query = accountsQuery();
  const qc = useQueryClient();
  const fleet = useFleetEngines();
  const canManage = $derived($authStore.can("auth.manage"));
  const hosts = hostsListQuery();
  const hostNames = $derived(new Map(($hosts.data?.hosts ?? []).map((host) => [host.id, host.fqdn])));

  const filterState = new UrlFilters({ q: "", engine: "all" });
  // A switched-off engine is not part of the fleet: no filter chip, no rows.
  const scope = $derived<Engine | "all">(isEngine(filterState.values.engine) && $fleet.isEnabled(filterState.values.engine) ? filterState.values.engine : "all");
  const search = $derived(filterState.values.q);
  let dialog = $state<AccountDialog | null>(null);

  const stored = $derived($query.data?.accounts ?? []);
  const accounts = $derived(stored.filter((a) => $fleet.isEnabled(a.engine)));
  // Kept server-side for a re-enable; counted so nobody thinks they were lost.
  const hidden = $derived(stored.length - accounts.length);
  const scoped = $derived(sortAccounts(scope === "all" ? accounts : accounts.filter((a) => a.engine === scope)));
  const visible = $derived(scoped.filter((a) => matchesSearch(a, search)));
  const attention = $derived(accounts.filter(needsAttention).length);
  // An engine with several usable accounts counts as near quota only when none of them has headroom.
  const nearQuota = $derived(nearQuotaCounted(accounts).length);
  const covered = $derived(poolCoveredIds(accounts));
  const stats = $derived([
    { label: accounts.length === 1 ? "account" : "accounts", value: accounts.length },
    { label: "need attention", value: attention, tone: attention ? ("danger" as const) : ("default" as const), hint: "Login needs renewal or verification failed" },
    { label: "near quota", value: nearQuota, tone: nearQuota ? ("warning" as const) : ("default" as const), hint: `Either usage window at ${NEAR_QUOTA_PERCENT}% or more. With several usable accounts of an engine, counted only when none has headroom.` },
  ]);

  // Policy is per engine: follow the engine filter, with Claude (the only live-switching engine) as the default view.
  const policyEngine = $derived<Engine | null>(scope !== "all" ? scope : $fleet.isEnabled("claude") ? "claude" : ($fleet.enabled[0] ?? null));

  const addDisabled = $derived($fleet.enabled.length === 0);
  const countLabel = $derived($query.data && (search.trim() || scope !== "all") ? `${visible.length} of ${accounts.length}` : "");

  const change = createMutation({
    mutationFn: async (input: { account: ProviderAccount; action: "state" | "rename" | "remove" | "verify"; label?: string }) => {
      const { account, action } = input;
      if (action === "remove") return accountsApi.remove(account.id);
      if (action === "verify") {
        const result = await accountsApi.verify(account.id);
        if (result.verification_state !== "verified") throw new Error(result.reason ?? `Verification ${result.verification_state}`);
        return result;
      }
      return accountsApi.update(account.id, action === "rename" ? { label: input.label } : { state: account.state === "enabled" ? "paused" : "enabled" });
    },
    onSuccess: () => { dialog = null; toast.success("Account updated"); },
    onError: (error) => toast.error(error.message),
    onSettled: () => { void qc.invalidateQueries({ queryKey: accountsKeys.all() }); },
  });
  const run = (account: ProviderAccount, action: "state" | "verify") => $change.mutate({ account, action });
</script>

<PageShell title="Accounts" description="Subscription accounts shared by the fleet. New sessions use verified accounts that still have quota." width="wide">
  {#snippet actions()}
    {#if canManage}<Button disabled={addDisabled} title={addDisabled ? "Enable an engine under Engines before adding an account." : undefined} onclick={() => (dialog = { kind: "add" })}>Add account</Button>{/if}
  {/snippet}
  {#snippet subheader()}
    {#if $query.data}
      <StatStrip items={stats} />
      {#if $query.isError}<p class="text-body-sm text-warning" role="status">Account counts reflect the last successful load.</p>{/if}
    {/if}
  {/snippet}

  <Toolbar bind:search={filterState.values.q} searchPlaceholder="Search accounts" count={countLabel} filtersActive={filterState.active} onClearFilters={() => filterState.clear()}>
    {#snippet filters()}<EngineFilter value={scope} engines={$fleet.enabled} onChange={(next) => (filterState.values.engine = next)} />{/snippet}
  </Toolbar>

  {#if hidden > 0}
    <p class="text-body-sm text-muted-foreground" role="status">
      {hidden} stored {hidden === 1 ? "account belongs" : "accounts belong"} to engines switched off fleet-wide and {hidden === 1 ? "is" : "are"} hidden. {hidden === 1 ? "It returns" : "They return"} when the engine is switched back on under <a class="text-primary underline-offset-2 hover:underline" href={`${base}/engines`}>Engines</a>.
    </p>
  {/if}

  <DataTable
    reflow
    items={visible}
    loading={$query.isPending}
    error={$query.error ?? null}
    onRetry={() => $query.refetch()}
    key={(account) => account.id}
    filtered={search.trim() !== "" && scoped.length > 0}
    onClearFilters={() => { filterState.values.q = ""; }}
    emptyTitle={scope === "all" ? "No accounts" : `No ${ENGINE_META[scope].label} accounts`}
    emptyDescription={`Add credentials here, or log in through ${(scope === "all" ? $fleet.enabled : [scope]).map((engine) => ENGINE_META[engine].command).join(", ")} on a registered host.`}
    caption="Provider accounts"
  >
    {#snippet emptyAction()}
      {#if canManage}<Button variant="outline" size="sm" disabled={addDisabled} onclick={() => (dialog = { kind: "add" })}>Add account</Button>{/if}
    {/snippet}
    {#snippet head()}
      <Table.Head>Account</Table.Head>
      <Table.Head>Usage</Table.Head>
      <Table.Head>Sessions</Table.Head>
      <Table.Head>Verified</Table.Head>
      <Table.Head class="w-10"><span class="sr-only">Actions</span></Table.Head>
    {/snippet}
    {#snippet row(account)}
      <AccountRow
        {account}
        engineOn={$fleet.isEnabled(account.engine)}
        {canManage}
        {hostNames}
        busy={$change.isPending}
        poolCovered={covered.has(account.id)}
        onQuota={() => (dialog = { kind: "quota", account })}
        onRename={() => (dialog = { kind: "rename", account })}
        onReplace={() => (dialog = { kind: "replace", account })}
        onVerify={() => run(account, "verify")}
        onToggle={() => run(account, "state")}
        onRemove={() => (dialog = { kind: "remove", account })}
      />
    {/snippet}
  </DataTable>

  {#if policyEngine}
    {#key policyEngine}<AccountPolicy engine={policyEngine} {canManage} />{/key}
    {#if policyEngine === "claude"}
      <AccountScopes engine="claude" accounts={accounts} {canManage} />
    {/if}
  {/if}
</PageShell>

<AccountDialogs
  {dialog}
  {scope}
  busy={$change.isPending}
  onClose={() => (dialog = null)}
  onRename={(account, label) => $change.mutate({ account, action: "rename", label })}
  onRemove={(account) => $change.mutate({ account, action: "remove" })}
  onStored={() => { dialog = null; void qc.invalidateQueries({ queryKey: accountsKeys.all() }); }}
/>
