<script lang="ts">
  import type { Snapshot } from "./$types";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { PageShell, StatStrip, Toolbar, DataTable } from "$lib/components/page";
  import * as Table from "$lib/components/ui/table";
  import { Button } from "$lib/components/ui/button";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import { accountsApi, accountsKeys, accountsQuery, type ProviderAccount } from "$lib/api/accounts";
  import { authStore } from "$lib/stores/auth";
  import { ENGINES, ENGINE_META, type Engine } from "$lib/constants/engines";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import AccountRow from "$lib/components/accounts/AccountRow.svelte";
  import AccountDialogs, { type AccountDialog } from "$lib/components/accounts/AccountDialogs.svelte";
  import EngineFilter from "$lib/components/accounts/EngineFilter.svelte";
  import { isNearQuota, matchesSearch, needsAttention, sortAccounts, NEAR_QUOTA_PERCENT } from "$lib/components/accounts/account-state";

  const query = accountsQuery();
  const qc = useQueryClient();
  const fleet = useFleetEngines();
  const canManage = $derived($authStore.can("auth.manage"));

  let scope = $state<Engine | "all">("all");
  let search = $state("");
  let dialog = $state<AccountDialog | null>(null);

  const accounts = $derived($query.data?.accounts ?? []);
  const scoped = $derived(sortAccounts(scope === "all" ? accounts : accounts.filter((a) => a.engine === scope)));
  const visible = $derived(scoped.filter((a) => matchesSearch(a, search)));
  const attention = $derived(accounts.filter(needsAttention).length);
  const nearQuota = $derived(accounts.filter(isNearQuota).length);
  const stats = $derived([
    { label: accounts.length === 1 ? "account" : "accounts", value: accounts.length },
    { label: "need attention", value: attention, tone: attention ? ("danger" as const) : ("default" as const), hint: "Login needs renewal or verification failed" },
    { label: "near quota", value: nearQuota, tone: nearQuota ? ("warning" as const) : ("default" as const), hint: `Either usage window at ${NEAR_QUOTA_PERCENT}% or more` },
  ]);

  // A fleet-disabled engine keeps its accounts, but anything that reaches the
  // provider (add, replace, verify) is refused by the server until it is on.
  const offEngines = $derived(ENGINES.filter((engine) => !$fleet.isEnabled(engine)));
  const addDisabled = $derived(scope === "all" ? offEngines.length === ENGINES.length : !$fleet.isEnabled(scope));
  const countLabel = $derived(search.trim() || scope !== "all" ? `${visible.length} of ${accounts.length}` : "");

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
  export const snapshot: Snapshot<{ scope: typeof scope, search: typeof search }> = {
    capture: () => ({ scope, search }),
    restore: (value) => { scope = value.scope; search = value.search; },
  };
</script>

<PageShell title="Accounts" description="Subscription accounts shared by the fleet. New sessions use verified accounts that still have quota." width="wide">
  {#snippet actions()}
    {#if canManage}<Button disabled={addDisabled} title={addDisabled ? "Enable an engine under Engines before adding an account." : undefined} onclick={() => (dialog = { kind: "add" })}>Add account</Button>{/if}
  {/snippet}
  {#snippet subheader()}<StatStrip items={stats} />{/snippet}

  <Toolbar bind:search searchPlaceholder="Search accounts" count={countLabel}>
    {#snippet filters()}<EngineFilter value={scope} isEnabled={(engine) => $fleet.isEnabled(engine)} onChange={(next) => (scope = next)} />{/snippet}
  </Toolbar>

  {#if offEngines.length}
    <Alert variant="warning" class="rounded-md px-3 py-2">
      <AlertDescription>
        {offEngines.map((engine) => ENGINE_META[engine].label).join(", ")} {offEngines.length === 1 ? "is" : "are"} off fleet-wide. Accounts are kept but not refreshed, verified or used;
        adding, replacing and verifying credentials is refused until the engine is back on under Engines.
      </AlertDescription>
    </Alert>
  {/if}

  <DataTable
    items={visible}
    loading={$query.isPending}
    error={$query.error?.message ?? null}
    onRetry={() => $query.refetch()}
    key={(account) => account.id}
    filtered={search.trim() !== "" && scoped.length > 0}
      onClearFilters={() => { search = ""; }}
    emptyTitle={scope === "all" ? "No accounts" : `No ${ENGINE_META[scope].account} accounts`}
    emptyDescription={`Add credentials here, or log in through ${scope === "all" ? "cdx, clx or cgx" : ENGINE_META[scope].command} on a registered host.`}
    caption="Provider accounts"
  >
    {#snippet emptyAction()}
      {#if canManage}<Button size="sm" disabled={addDisabled} onclick={() => (dialog = { kind: "add" })}>Add account</Button>{/if}
    {/snippet}
    {#snippet head()}
      <Table.Head>Account</Table.Head>
      <Table.Head>Engine</Table.Head>
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
        busy={$change.isPending}
        onRename={() => (dialog = { kind: "rename", account })}
        onReplace={() => (dialog = { kind: "replace", account })}
        onVerify={() => run(account, "verify")}
        onToggle={() => run(account, "state")}
        onRemove={() => (dialog = { kind: "remove", account })}
      />
    {/snippet}
  </DataTable>
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
