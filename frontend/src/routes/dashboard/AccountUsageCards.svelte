<script lang="ts">
  import { ENGINE_META } from "$lib/constants/engines";
  import type { ProviderAccount } from "$lib/api/accounts";
  import { base } from "$app/paths";
  import { Badge } from "$lib/components/ui/badge";
  import { cn } from "$lib/utils/cn";
  import { relativeTime, resetsIn } from "$lib/utils/format";
  import { useFleetEngines, FLEET_DISABLED_TAG, fleetDisabledTitle } from "$lib/engines/fleet-engines";
  import GrokUsage from "$lib/components/dashboard/GrokUsage.svelte";
  import UsageMeter from "$lib/components/dashboard/UsageMeter.svelte";
  import { accountQuotaRows } from "$lib/components/dashboard/account-usage";

  let { accounts }: { accounts: ProviderAccount[] } = $props();
  const fleet = useFleetEngines();
  const borders = {
    codex: "border-t-persona-codex",
    claude: "border-t-persona-claude",
    grok: "border-t-persona-grok",
  };
</script>

{#each accounts as account (account.id)}
  {@const off = !$fleet.isEnabled(account.engine)}
  {@const rows = accountQuotaRows(account)}
  {@const hasReading = account.engine === "grok" ? !!account.usage.current_window : rows.length > 0}
  <a
    href={`${base}/accounts`}
    aria-labelledby={`usage-account-${account.id}`}
    class={cn(
      "flex min-w-0 flex-col gap-4 rounded-xl border border-t-2 bg-card p-5 text-card-foreground transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      borders[account.engine], off && "opacity-70",
    )}
  >
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-3">
        <span class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span class={cn("h-2 w-2 rounded-full", ENGINE_META[account.engine].color)} aria-hidden="true"></span>
          {ENGINE_META[account.engine].account}
        </span>
        <Badge variant="outline">{account.state}</Badge>
      </div>
      <h2 id={`usage-account-${account.id}`} class="break-words text-base font-semibold">{account.label}</h2>
      <p class="text-xs text-muted-foreground">
        {account.verification_state} · {account.sessions.length} active sessions
      </p>
      {#if off}<Badge variant="warning" title={fleetDisabledTitle(ENGINE_META[account.engine].label)}>{FLEET_DISABLED_TAG}</Badge>{/if}
      {#if account.refresh_state === "login_required"}<p class="text-xs text-destructive">Subscription login needs renewal</p>{/if}
    </div>

    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid="provider-plan">
        <span class="text-muted-foreground">Plan</span>
        <span class="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{account.plan?.name ?? "Plan unavailable"}</Badge>
          {#if account.plan?.name && account.plan.stale}<Badge variant="warning">Last known plan</Badge>{/if}
        </span>
        {#if account.plan?.name}
          <span class="w-full text-muted-foreground">
            {account.plan.source === "claude_login" ? "Login metadata" : "Provider reported"}
            {#if account.plan.observed_at}
              · <time datetime={account.plan.observed_at} title={account.plan.observed_at}>{relativeTime(account.plan.observed_at)}</time>
            {/if}
          </span>
        {/if}
      </div>
      {#if account.usage.supported === false}
        <p class="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">Subscription quota unavailable</p>
      {:else if account.engine === "grok"}
        <GrokUsage usage={account.usage} label={account.label} showStatus={false} showUpdated={false} />
      {:else if rows.length}
        {#each rows as row (row.key)}
          {@const when = resetsIn(row.reset)}
          <div class="space-y-2">
            <UsageMeter label={row.label} usedPercent={row.value} valueLabel={`${row.value}% used`} />
            {#if when === "passed"}
              <p class="text-xs text-muted-foreground">Reset passed</p>
            {:else if when}
              <p class="text-xs text-muted-foreground">Resets <time datetime={row.reset ?? undefined} title={row.reset ?? undefined}>{when}</time></p>
            {/if}
          </div>
        {/each}
      {:else}
        <p class="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          {account.usage.fetched_at ? "No quota windows reported" : "Waiting for usage data"}
        </p>
      {/if}
    </div>

    <div class="mt-auto flex min-h-9 flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
      {#if relativeTime(account.usage.fetched_at)}
        <span>Updated <time datetime={account.usage.fetched_at ?? undefined} title={account.usage.fetched_at ?? undefined}>{relativeTime(account.usage.fetched_at)}</time></span>
      {:else}
        <span>No reading recorded</span>
      {/if}
      {#if account.usage.stale && hasReading}<Badge variant="warning">Last known reading</Badge>{/if}
    </div>
  </a>
{/each}
