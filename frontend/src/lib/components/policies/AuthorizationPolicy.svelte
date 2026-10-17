<script lang="ts">
  import { authorizationQuery, authorizationMutation } from "$lib/api/settings";
  import { authStore } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import * as Table from "$lib/components/ui/table";
  import { DataTable } from "$lib/components/page";
  import PolicyRow from "./PolicyRow.svelte";
  const query = authorizationQuery();
  const mutation = authorizationMutation();
  const canManage = $derived($authStore.can("security.manage_authorization"));
  const disabled = $derived(!canManage || !$query.isSuccess || $query.isFetching || $mutation.isPending);
  const wouldDeny = $derived($query.data?.would_deny ?? []);
</script>

<PolicyRow
  id="authorization"
  label="Role checks"
  term="authorization mode"
  controlId="authorization-mode"
  help="How strictly the server checks each role's capabilities on protected routes."
  details="Compatible mode preserves legacy role rules and records requests strict mode would refuse. Strict mode requires the capability assigned to each route. Recorded requests are evidence of past activity, not a guarantee about future access."
>
  {#snippet control()}
    <select
      id="authorization-mode"
      class="h-9 rounded-md border border-input bg-background px-3 text-body-sm"
      value={$query.data?.mode ?? "compatible"}
      {disabled}
      onchange={(event) => {
        const mode = event.currentTarget.value === "strict" ? "strict" : "compatible";
        event.currentTarget.value = $query.data?.mode ?? "compatible";
        $mutation.mutate(mode);
      }}
    >
      <option value="compatible">Compatible: legacy role rules</option>
      <option value="strict">Strict: enforce capabilities</option>
    </select>
  {/snippet}
  <p role="status" class="text-body-sm text-muted-foreground">
    {#if $query.isPending}Loading current setting…
    {:else if $query.isError}<span class="text-destructive">Could not load setting: {$query.error.message}</span>
    {:else if $mutation.isPending}Saving…
    {:else if $mutation.isError}<span class="text-destructive">Save failed: {$mutation.error.message}. The saved mode is unchanged.</span>
    {:else}Current mode: {$query.data?.mode}{#if $mutation.isSuccess} · Saved{/if}{/if}
  </p>
  {#if $query.isError}<Button variant="outline" size="sm" class="mt-1" onclick={() => void $query.refetch()}>Retry loading</Button>{/if}
  {#if $query.isSuccess && $query.data.mode === "compatible"}
    <p class="mt-1 text-body-sm">
      {#if !wouldDeny.length}No conflicting requests recorded. Review role assignments before switching to strict mode.
      {:else}<strong>{wouldDeny.length} conflicting request {wouldDeny.length === 1 ? "pattern" : "patterns"} recorded.</strong> Strict mode would refuse these requests. Review the affected role assignments first.{/if}
    </p>
  {/if}
  {#if wouldDeny.length}
    <details class="mt-2 text-body-sm" open>
      <summary class="w-fit cursor-pointer font-medium">Requests strict mode would refuse</summary>
      <div class="mt-2">
        <DataTable items={wouldDeny} key={(record) => record.role + record.capability + record.route} caption="Authorization evidence">
          {#snippet head()}
            <Table.Head>Role</Table.Head><Table.Head>Required capability</Table.Head><Table.Head>Route</Table.Head><Table.Head>Last seen</Table.Head>
          {/snippet}
          {#snippet row(record)}
            <Table.Row>
              <Table.Cell>{record.role}</Table.Cell>
              <Table.Cell><code class="break-all font-mono text-caption">{record.capability}</code></Table.Cell>
              <Table.Cell><code class="break-all font-mono text-caption">{record.route}</code></Table.Cell>
              <Table.Cell class="text-body-sm">{new Date(record.last_seen).toLocaleString()}</Table.Cell>
            </Table.Row>
          {/snippet}
        </DataTable>
      </div>
    </details>
  {/if}
  {#if !canManage}<p class="mt-1 text-caption text-muted-foreground">Read only. Requires security.manage_authorization.</p>{/if}
</PolicyRow>
