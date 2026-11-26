<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  /**
   * Provider usage as one table: a row per account, its quota windows inline. An engine with
   * several accounts gets a collapsible group header (the same as on Accounts); the expanded
   * engines live in the `open` URL parameter.
   */
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { DataTable, StateBlock } from "$lib/components/page";
  import { ENGINE_META } from "$lib/constants/engines";
  import type { ProviderAccount } from "$lib/api/accounts";
  import { periodElapsedPercent, resetsIn } from "$lib/utils/format";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { cn } from "$lib/utils/cn";
  import KimiUsage from "./KimiUsage.svelte";
  import GrokUsage from "./GrokUsage.svelte";
  import UsageMeter from "./UsageMeter.svelte";
  import { accountQuotaRows, expiringAtNextReset, poolQuotaRows } from "./account-usage";
  import AccountGroupRow from "$lib/components/accounts/AccountGroupRow.svelte";
  import { accountEntries, displayName, entryKey, parseOpen, toggleOpen, type EnginePool } from "$lib/components/accounts/account-state";

  type Props = {
    accounts: ProviderAccount[] | undefined;
    loading?: boolean;
    error?: string | Error | null;
    onRetry?: () => void;
  };
  let { accounts, loading = false, error = null, onRetry }: Props = $props();
  const fleet = useFleetEngines();
  const visibleAccounts = $derived(accounts?.filter((account) => $fleet.isEnabled(account.engine)));
  const entries = $derived(visibleAccounts && accountEntries(visibleAccounts, "listed"));
  const openGroups = $derived(parseOpen(page.url.searchParams.get("open")));
  function toggle(engine: string) {
    const params = new URLSearchParams(page.url.searchParams);
    const next = toggleOpen(params.get("open"), engine);
    if (next) params.set("open", next);
    else params.delete("open");
    const query = params.toString();
    void goto(query ? `?${query}` : page.url.pathname, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function status(account: ProviderAccount): { label: string; variant: "success" | "warning" | "destructive" | "secondary" } {
    if (account.refresh_state === "login_required") return { label: "Login needed", variant: "destructive" };
    if (account.verification_state === "failed") return { label: "Verification failed", variant: "destructive" };
    if (account.state === "paused") return { label: "Paused", variant: "secondary" };
    if (account.state === "removing") return { label: "Removing", variant: "secondary" };
    if (account.verification_state !== "verified") return { label: "Not verified yet", variant: "warning" };
    return { label: "Active", variant: "success" };
  }

  /** Named only when some usable account has no current reading: an unmeasured account is not zero. */
  function poolCoverage(rows: ReturnType<typeof poolQuotaRows>): string | null {
    const partial = rows.filter((row) => row.reporting < row.of);
    return partial.length ? `Average of ${partial.map((row) => `${row.reporting} of ${row.of} accounts (${row.label.toLowerCase()})`).join(", ")}` : null;
  }

  /** The oldest reading behind the pool meters: the average is only as current as that. */
  function poolUpdated(pool: EnginePool): { at: string | null; stale: boolean } {
    const read = pool.usable.filter((account) => account.usage.fetched_at);
    const oldest = read.map((account) => account.usage.fetched_at!).sort()[0] ?? null;
    return { at: oldest, stale: read.some((account) => account.usage.stale) };
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

{#if $fleet.enabled.length === 0}
  <StateBlock state="empty" message="All engines are disabled fleet-wide" description="Enable an engine to see provider usage. Retained accounts remain available in Accounts.">
    {#snippet action()}<Button variant="outline" href={`${base}/engines`}>Configure engines</Button>{/snippet}
  </StateBlock>
{:else}
<DataTable
  reflow
  items={entries}
  {loading}
  {error}
  {onRetry}
  key={entryKey}
  caption="Provider accounts and their quota usage"
  emptyTitle="No accounts for enabled engines"
  emptyDescription="Manage retained accounts or add a login for an enabled engine in Accounts."
>
  {#snippet emptyAction()}<Button variant="outline" href={`${base}/accounts`}>Go to Accounts</Button>{/snippet}
  {#snippet head()}
    <Table.Head>Account</Table.Head>
    <Table.Head>Status</Table.Head>
    <Table.Head class="min-w-72">Usage</Table.Head>
    <Table.Head class="whitespace-nowrap">Reset in</Table.Head>
    <Table.Head>Updated</Table.Head>
  {/snippet}
  {#snippet row(entry)}
    {#if entry.kind === "group"}
      {@const open = openGroups.has(entry.pool.engine)}
      <AccountGroupRow pool={entry.pool} columns={5} {open} onToggle={() => toggle(entry.pool.engine)} trailing={poolCells} />
      {#if open}
        {#each entry.rows as account (account.id)}{@render accountRow(account, true)}{/each}
      {/if}
    {:else}
      {@render accountRow(entry.account, false)}
    {/if}
  {/snippet}
</DataTable>
{/if}

{#snippet poolCells(pool: EnginePool)}
    {@const rows = poolQuotaRows(pool.usable, periodElapsedPercent)}
    {@const updated = poolUpdated(pool)}
    {@const expiring = expiringAtNextReset(pool.usable)}
    <Table.Cell>
      {#if rows.length}
        <div class="space-y-1">
          {#each rows as quota (quota.key)}
            <UsageMeter inline label={quota.label} usedPercent={quota.value} valueLabel={`${Math.round(quota.value)}% avg`} elapsedPercent={quota.elapsed} />
          {/each}
        </div>
        {@const coverage = poolCoverage(rows)}
        {#if coverage}<p class="mt-1 text-caption text-muted-foreground" data-testid="pool-coverage">{coverage}</p>{/if}
        <!-- Quota left at a reset is lost: the averages above cannot show which account is about to lose it. -->
        {#if expiring}
          <p class="mt-1 text-caption text-muted-foreground" data-testid="pool-expiring">
            Expires at the next reset:
            {#each expiring.accounts as entry, index (entry.account.id)}{index ? ", " : ""}<span class="font-medium text-foreground">{Math.round(entry.unused)}%</span> of {displayName(entry.account)}{/each}
          </p>
        {/if}
      {:else}
        <span class="text-body-sm text-muted-foreground">{!pool.usable.length ? "No usable account" : pool.usable.every((account) => account.usage.supported === false) ? "Subscription quota unavailable" : "Waiting for usage data"}</span>
      {/if}
    </Table.Cell>
    <Table.Cell class="whitespace-nowrap text-body-sm text-muted-foreground" data-testid="reset-in">
      {#if rows.some((row) => row.reset)}
        <span class="text-caption sm:hidden">Next reset in</span>
        <div class="space-y-1">
          {#each rows as quota (quota.key)}
            {@const when = resetsIn(quota.reset)}
            <p title="The first reset among the pool's accounts">{#if rows.length > 1}<span class="mr-1 text-caption">{quota.label}:</span>{/if}<time datetime={quota.reset ?? undefined}>{quota.reset ? when === "passed" ? "Reset passed" : when || "Unknown" : "Unknown"}</time></p>
          {/each}
        </div>
      {:else}<span aria-label="No reset time">—</span>{/if}
    </Table.Cell>
    <Table.Cell class={cn("whitespace-nowrap text-body-sm", updated.stale ? "text-warning" : "text-muted-foreground")}
      title={updated.stale ? "At least one account's reading is the last reported one. Refresh to check for newer readings." : "The oldest reading behind the average"}>
      {#if updated.at}
        <span class="sm:hidden">Updated&nbsp;</span><Timestamp value={updated.at} />
      {:else}No reading yet{/if}
    </Table.Cell>
{/snippet}

{#snippet accountRow(account: ProviderAccount, nested: boolean)}
    {@const rows = accountQuotaRows(account)}
    {@const grok = account.engine === "grok" ? account.usage.current_window : null}
    {@const state = status(account)}
    {@const resets = resetLines(account, rows)}
    <Table.Row>
      <Table.Cell>
        <a href={`${base}/accounts`} class={cn("flex items-center gap-2 font-medium hover:underline", nested && "pl-6")}>
          <span class={cn("h-2 w-2 shrink-0 rounded-full", ENGINE_META[account.engine].color)} aria-hidden="true"></span>
          <span class="min-w-0 break-words">{displayName(account)}</span>
        </a>
        <p class={cn("mt-0.5 text-body-sm text-muted-foreground", nested && "pl-6")} data-testid="provider-plan">
          {ENGINE_META[account.engine].label} · {account.plan?.name ?? "Plan unavailable"}{account.plan?.name && account.plan.stale ? " (last known)" : ""}
        </p>
      </Table.Cell>
      <Table.Cell>
        <div class="flex flex-wrap items-center gap-1">
          <Badge variant={state.variant} title={`Verification: ${account.verification_state}`}>{state.label}</Badge>
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
          <span class="text-caption sm:hidden">Resets in</span>
          <div class="space-y-1">
            {#each resets as reset (reset.key)}
              <p>{#if reset.label}<span class="mr-1 text-caption">{reset.label}:</span>{/if}<time datetime={reset.at ?? undefined} title={reset.at ?? undefined}>{reset.when}</time></p>
            {/each}
          </div>
        {:else}<span aria-label="No reset time">—</span>{/if}
      </Table.Cell>
      <Table.Cell class={cn("whitespace-nowrap text-body-sm", account.usage.stale && account.usage.fetched_at ? "text-warning" : "text-muted-foreground")}
        title={account.usage.stale && account.usage.fetched_at ? "Last reported usage. Refresh to check for a newer reading." : undefined}>
        {#if account.usage.fetched_at}
          <span class="sm:hidden">Updated&nbsp;</span><Timestamp value={account.usage.fetched_at} />
        {:else}No reading yet{/if}
      </Table.Cell>
    </Table.Row>
{/snippet}
