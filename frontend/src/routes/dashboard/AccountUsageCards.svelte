<script lang="ts">
  import type { ProviderAccount } from "$lib/api/accounts";
  import { base } from "$app/paths";
  let { accounts }: { accounts: ProviderAccount[] } = $props();
</script>
{#each accounts as account (account.id)}
  <a href={`${base}/accounts`} class="rounded-xl border bg-card p-5 text-card-foreground hover:border-primary">
    <div class="flex items-center justify-between gap-3">
      <h2 class="font-semibold">{account.label}</h2>
      <span class="text-sm text-muted-foreground">{account.engine === 'claude' ? 'Claude' : 'ChatGPT'} · {account.state}</span>
    </div>
    <p class="mt-2 text-sm text-muted-foreground">{account.verification_state} · {account.sessions.length} active sessions{account.usage.stale ? ' · usage stale or unknown' : ''}</p>
    <div class="mt-4 grid grid-cols-2 gap-4 text-sm">
      {#each [{ label: 'Short window', value: account.usage.short_used_percent }, { label: 'Weekly window', value: account.usage.weekly_used_percent }] as window}
        <div>
          <div class="flex justify-between"><span>{window.label}</span><span>{window.value === null ? 'Unknown' : `${window.value}%`}</span></div>
          {#if window.value !== null}<progress aria-label={`${account.label} ${window.label}`} class="mt-2 h-2 w-full accent-primary" max="100" value={window.value}></progress>{/if}
        </div>
      {/each}
    </div>
  </a>
{/each}
