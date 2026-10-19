<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  /** Provider usage as one table: a row per account, its quota windows inline. */
  import { base } from "$app/paths";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { DataTable } from "$lib/components/page";
  import { ENGINE_META } from "$lib/constants/engines";
  import type { ProviderAccount } from "$lib/api/accounts";
  import { resetsIn } from "$lib/utils/format";
  import { useFleetEngines, FLEET_DISABLED_TAG, fleetDisabledTitle } from "$lib/engines/fleet-engines";
  import { cn } from "$lib/utils/cn";
  import GrokUsage from "./GrokUsage.svelte";
  import UsageMeter from "./UsageMeter.svelte";
  import { accountQuotaRows } from "./account-usage";

  type Props = {
    accounts: ProviderAccount[] | undefined;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
  };
  let { accounts, loading = false, error = null, onRetry }: Props = $props();
  const fleet = useFleetEngines();

  function status(account: ProviderAccount): { label: string; variant: "success" | "warning" | "destructive" | "secondary" } {
    if (account.refresh_state === "login_required") return { label: "Login needed", variant: "destructive" };
    if (account.verification_state === "failed") return { label: "Verification failed", variant: "destructive" };
    if (account.state === "paused") return { label: "Paused", variant: "secondary" };
    if (account.state === "removing") return { label: "Removing", variant: "secondary" };
    if (account.verification_state !== "verified") return { label: "Not verified yet", variant: "warning" };
    return { label: "Active", variant: "success" };
  }

  function resetText(value: string | null | undefined): string {
    const when = resetsIn(value);
    return when === "passed" ? "Reset passed" : when ? `Resets ${when}` : "";
  }
</script>

<DataTable
  items={accounts}
  {loading}
  {error}
  {onRetry}
  key={(account) => account.id}
  caption="Provider accounts and their quota usage"
  emptyTitle="No provider accounts yet"
  emptyDescription="Add a ChatGPT, Claude or Grok login to see quota usage here."
>
  {#snippet head()}
    <Table.Head>Account</Table.Head>
    <Table.Head>Status</Table.Head>
    <Table.Head class="min-w-72">Usage</Table.Head>
    <Table.Head>Updated</Table.Head>
  {/snippet}
  {#snippet row(account)}
    {@const off = !$fleet.isEnabled(account.engine)}
    {@const rows = accountQuotaRows(account)}
    {@const grok = account.engine === "grok" ? account.usage.current_window : null}
    {@const state = status(account)}
    <Table.Row class={cn(off && "opacity-70")}>
      <Table.Cell>
        <a href={`${base}/accounts`} class="flex items-center gap-2 font-medium hover:underline">
          <span class={cn("h-2 w-2 shrink-0 rounded-full", ENGINE_META[account.engine].color)} aria-hidden="true"></span>
          <span class="min-w-0 break-words">{account.label}</span>
        </a>
        <p class="mt-0.5 text-body-sm text-muted-foreground" data-testid="provider-plan">
          {ENGINE_META[account.engine].account} · {account.plan?.name ?? "Plan unavailable"}{account.plan?.name && account.plan.stale ? " (last known)" : ""}
        </p>
      </Table.Cell>
      <Table.Cell>
        <div class="flex flex-wrap items-center gap-1">
          <Badge variant={state.variant} title={`Verification: ${account.verification_state}`}>{state.label}</Badge>
          {#if off}<Badge variant="warning" title={fleetDisabledTitle(ENGINE_META[account.engine].label)}>{FLEET_DISABLED_TAG}</Badge>{/if}
        </div>
        <p class="mt-0.5 text-body-sm text-muted-foreground">{account.sessions.length} active {account.sessions.length === 1 ? "session" : "sessions"}</p>
      </Table.Cell>
      <Table.Cell>
        {#if account.usage.supported === false}
          <span class="text-body-sm text-muted-foreground">Subscription quota unavailable</span>
        {:else if account.engine === "grok"}
          <GrokUsage inline usage={account.usage} label={account.label} showStatus={false} showUpdated={false} />
        {:else if rows.length}
          <div class="space-y-1">
            {#each rows as quota (quota.key)}
              <UsageMeter inline label={quota.label} usedPercent={quota.value} valueLabel={`${quota.value}% used`} />
              {#if resetText(quota.reset)}
                <p class="-mt-0.5 ml-2 pl-28 text-caption text-muted-foreground">{resetText(quota.reset)}</p>
              {/if}
            {/each}
          </div>
        {:else}
          <span class="text-body-sm text-muted-foreground">{account.usage.fetched_at ? "No quota windows reported" : "Waiting for usage data"}</span>
        {/if}
      </Table.Cell>
      <Table.Cell class="whitespace-nowrap text-body-sm text-muted-foreground">
        {#if account.usage.fetched_at}
          <time datetime={account.usage.fetched_at} title={account.usage.fetched_at}><Timestamp value={account.usage.fetched_at} /></time>
        {:else}No reading yet{/if}
      </Table.Cell>
    </Table.Row>
  {/snippet}
</DataTable>
