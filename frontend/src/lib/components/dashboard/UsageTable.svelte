<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  /** Provider usage as one table: a row per account, its quota windows inline. */
  import { base } from "$app/paths";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { DataTable } from "$lib/components/page";
  import { ENGINE_META } from "$lib/constants/engines";
  import type { ProviderAccount } from "$lib/api/accounts";
  import { periodElapsedPercent, resetsIn } from "$lib/utils/format";
  import { useFleetEngines, FLEET_DISABLED_TAG, fleetDisabledTitle } from "$lib/engines/fleet-engines";
  import { cn } from "$lib/utils/cn";
  import GrokUsage from "./GrokUsage.svelte";
  import UsageMeter from "./UsageMeter.svelte";
  import { accountQuotaRows } from "./account-usage";

  type Props = {
    accounts: ProviderAccount[] | undefined;
    loading?: boolean;
    error?: string | Error | null;
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

  /** One line per quota window for the "Reset in" column; unknown stays unknown. */
  function resetLines(account: ProviderAccount, rows: ReturnType<typeof accountQuotaRows>): { key: string; label: string | null; when: string; at: string | null }[] {
    const window = account.engine === "grok" ? account.usage.current_window : null;
    const sources = account.engine === "grok"
      ? window ? [{ key: "grok", label: null, at: window.resets_at }] : []
      : rows.map((quota) => ({ key: quota.key, label: rows.length > 1 ? quota.label : null, at: quota.reset ?? null }));
    return sources.map((source) => {
      const when = resetsIn(source.at);
      return { key: source.key, label: source.label, at: source.at, when: when === "passed" ? "Reset passed" : when || "Unknown" };
    });
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
  {#snippet emptyAction()}<Button variant="outline" href={`${base}/accounts`}>Go to Accounts</Button>{/snippet}
  {#snippet head()}
    <Table.Head>Account</Table.Head>
    <Table.Head>Status</Table.Head>
    <Table.Head class="min-w-72">Usage</Table.Head>
    <Table.Head class="whitespace-nowrap">Reset in</Table.Head>
    <Table.Head>Updated</Table.Head>
  {/snippet}
  {#snippet row(account)}
    {@const off = !$fleet.isEnabled(account.engine)}
    {@const rows = accountQuotaRows(account)}
    {@const grok = account.engine === "grok" ? account.usage.current_window : null}
    {@const state = status(account)}
    {@const resets = resetLines(account, rows)}
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
          <GrokUsage inline usage={account.usage} label={account.label} showStatus={false} showUpdated={false} showReset={false} />
        {:else if rows.length}
          <div class="space-y-1">
            {#each rows as quota (quota.key)}
              <UsageMeter inline label={quota.label} usedPercent={quota.value} valueLabel={`${quota.value}% used`} elapsedPercent={periodElapsedPercent(quota.reset, { limitSeconds: quota.seconds })} />
            {/each}
          </div>
        {:else}
          <span class="text-body-sm text-muted-foreground">{account.usage.fetched_at ? "No quota windows reported" : "Waiting for usage data"}</span>
        {/if}
        {#if account.quota_snapshot?.emulation.enabled && !account.quota_policy?.unlimited}
          {#if account.quota_snapshot.short?.source === 'emulated'}
            {#if account.engine === 'grok'}
              <UsageMeter inline label={`Emulated ${Math.round((account.quota_snapshot.short.limit_seconds ?? 18000) / 3600)}-hour window`} usedPercent={account.quota_snapshot.short.used_percent} elapsedPercent={periodElapsedPercent(account.quota_snapshot.short.resets_at, { limitSeconds: account.quota_snapshot.short.limit_seconds ?? 18000 })} />
            {/if}
            {#if account.quota_snapshot.short.status !== 'fresh'}<p class="text-caption text-muted-foreground">Emulated quota stale — work allowed</p>{/if}
          {:else if typeof account.usage.short_used_percent !== "number"}
            <p class="text-caption text-muted-foreground">Emulated quota unavailable — work allowed</p>
          {/if}
        {/if}
      </Table.Cell>
      <Table.Cell class="whitespace-nowrap text-body-sm text-muted-foreground" data-testid="reset-in">
        {#if resets.length}
          <div class="space-y-1">
            {#each resets as reset (reset.key)}
              <p>{#if reset.label}<span class="mr-1 text-caption">{reset.label}:</span>{/if}<time datetime={reset.at ?? undefined} title={reset.at ?? undefined}>{reset.when}</time></p>
            {/each}
          </div>
        {:else}<span aria-label="No reset time">—</span>{/if}
      </Table.Cell>
      <Table.Cell class={cn("whitespace-nowrap text-body-sm", account.usage.stale && account.usage.fetched_at ? "text-warning" : "text-muted-foreground")}
        title={account.usage.stale && account.usage.fetched_at ? "Last known reading; the latest update did not succeed" : undefined}>
        {#if account.usage.fetched_at}
          <Timestamp value={account.usage.fetched_at} />
        {:else}No reading yet{/if}
      </Table.Cell>
    </Table.Row>
  {/snippet}
</DataTable>
