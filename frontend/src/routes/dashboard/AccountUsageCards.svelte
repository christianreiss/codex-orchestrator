<script lang="ts">
  import { ENGINE_META } from "$lib/constants/engines";
  import type { ProviderAccount } from "$lib/api/accounts";
  import { base } from "$app/paths";
  import { Badge } from "$lib/components/ui/badge";
  import { cn } from "$lib/utils/cn";
  import { useFleetEngines, FLEET_DISABLED_TAG, fleetDisabledTitle } from "$lib/engines/fleet-engines";
  let { accounts }: { accounts: ProviderAccount[] } = $props();
  // Accounts of a fleet-disabled engine are kept but not polled or leased.
  const fleet = useFleetEngines();
</script>
{#each accounts as account (account.id)}
  {@const off = !$fleet.isEnabled(account.engine)}
  <a href={`${base}/accounts`} class={cn("rounded-xl border bg-card p-5 text-card-foreground hover:border-primary", off && "opacity-70")}>
    <div class="flex items-center justify-between gap-3">
      <h2 class="flex items-center gap-2 font-semibold">
        {account.label}
        {#if off}<Badge variant="warning" title={fleetDisabledTitle(ENGINE_META[account.engine].label)}>{FLEET_DISABLED_TAG}</Badge>{/if}
      </h2>
      <span class="text-sm text-muted-foreground">{ENGINE_META[account.engine].account} · {account.state}</span>
    </div>
    <p class="mt-2 text-sm text-muted-foreground">{account.verification_state} · {account.sessions.length} active sessions{account.usage.stale ? ' · usage stale or unknown' : ''}</p>
    {#if account.refresh_state === "login_required"}<p class="mt-2 text-sm text-destructive">Subscription login needs renewal</p>{/if}
    {#if account.usage.supported === false}
      <p class="mt-4 text-sm text-muted-foreground">Subscription quota unavailable</p>
    {:else}
    <div class="mt-4 grid grid-cols-2 gap-4 text-sm">
      {#each [{ label: 'Short window', value: account.usage.short_used_percent }, { label: 'Weekly window', value: account.usage.weekly_used_percent }] as window}
        <div>
          <div class="flex justify-between"><span>{window.label}</span><span>{window.value === null ? 'Unknown' : `${window.value}%`}</span></div>
          {#if window.value !== null}<progress aria-label={`${account.label} ${window.label}`} class="mt-2 h-2 w-full accent-primary" max="100" value={window.value}></progress>{/if}
        </div>
      {/each}
    </div>
    {/if}
  </a>
{/each}
