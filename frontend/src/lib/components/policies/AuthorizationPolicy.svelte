<script lang="ts">
  import { authorizationQuery, authorizationMutation } from "$lib/api/settings";
  import { authStore } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import PolicyCard from "./PolicyCard.svelte";
  const query = authorizationQuery();
  const mutation = authorizationMutation();
  const disabled = $derived(!$authStore.can("security.manage_authorization") || !$query.isSuccess || $query.isFetching || $mutation.isPending);
</script>
<PolicyCard id="authorization" title="Role enforcement" scope="Fleet access control · administrator capabilities"
  description="Choose how the server checks role capabilities on protected routes."
  details="Compatible mode preserves legacy role rules and records requests strict mode would refuse. Strict mode requires the capability assigned to each route. Recorded requests are evidence of past activity, not a guarantee about future access.">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div><label for="authorization-mode" class="text-sm font-medium">Authorization mode</label><p class="mt-1 text-xs text-muted-foreground">Changes apply immediately.</p></div>
    <select id="authorization-mode" class="rounded-md border border-input bg-background px-3 py-2 text-sm" value={$query.data?.mode ?? "compatible"} {disabled}
      onchange={(event) => {
        const mode = event.currentTarget.value === "strict" ? "strict" : "compatible";
        event.currentTarget.value = $query.data?.mode ?? "compatible";
        $mutation.mutate(mode);
      }}>
      <option value="compatible">Compatible — legacy role rules</option><option value="strict">Strict — enforce capabilities</option>
    </select>
  </div>
  <p role="status" class="text-sm text-muted-foreground">
    {#if $query.isPending}Loading current policy…
    {:else if $query.isError}<span class="text-destructive">Could not load policy: {$query.error.message}</span>
    {:else if $mutation.isPending}Saving…
    {:else if $mutation.isError}<span class="text-destructive">Save failed: {$mutation.error.message}. The saved mode is unchanged.</span>
    {:else}Current mode: {$query.data?.mode}{#if $mutation.isSuccess} · Saved{/if}{/if}
  </p>
  {#if $query.isError}<Button variant="outline" size="sm" onclick={() => void $query.refetch()}>Retry loading</Button>{/if}
  {#if $query.isSuccess && $query.data.mode === "compatible"}
    <div class="rounded-lg bg-muted/40 p-3 text-sm">
      {#if !$query.data.would_deny.length}No conflicting requests recorded. Review role assignments before switching to strict mode.
      {:else}<strong>{$query.data.would_deny.length} conflicting request patterns recorded.</strong> Strict mode would refuse these requests. Review the affected role assignments first.{/if}
    </div>
  {/if}
  {#if $query.data?.would_deny.length}
    <details class="text-sm" open>
      <summary class="cursor-pointer font-medium">Requests strict mode would refuse</summary>
      <!-- Keyboard focus enables horizontal scrolling of the evidence table. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="mt-3 overflow-x-auto rounded-lg border" tabindex="0" role="region" aria-label="Authorization evidence">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/40"><tr><th class="p-3">Role</th><th class="p-3">Required capability</th><th class="p-3">Route</th><th class="p-3">Last seen</th></tr></thead>
          <tbody>{#each $query.data.would_deny as record (record.role + record.capability + record.route)}
            <tr class="border-t"><td class="p-3">{record.role}</td><td class="p-3"><code>{record.capability}</code></td><td class="p-3"><code>{record.route}</code></td><td class="whitespace-nowrap p-3">{new Date(record.last_seen).toLocaleString()}</td></tr>
          {/each}</tbody>
        </table>
      </div>
    </details>
  {/if}
  {#if !$authStore.can("security.manage_authorization")}<p class="text-xs text-muted-foreground">Read only. Requires security.manage_authorization.</p>{/if}
</PolicyCard>
