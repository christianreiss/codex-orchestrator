<script lang="ts">
  /**
   * Agent roles in the Library: the module switch (its one editable home), the
   * role list and "New role". Agents improve roles themselves; this list shows
   * where the operator may want to steer — held proposals, frozen roles.
   */
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { rolesApi, rolesKeys, type RoleListRow } from "$lib/api/roles";
  import { relativeTime } from "$lib/utils/format";
  import { DataTable, StateBlock, Toolbar } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Table from "$lib/components/ui/table";
  import CreateRoleSheet from "./CreateRoleSheet.svelte";
  import { libraryRoleHref } from "../library-types";
  import { mutationLabel } from "./role-model";

  const query = createQuery(reactiveOptions(() => ({ queryKey: [...rolesKeys.list()], queryFn: () => rolesApi.list() })));
  const enabled = $derived($query.data?.enabled ?? false);
  const items = $derived($query.data?.roles ?? []);
  let search = $state("");
  let createOpen = $state(false);

  const filtered = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((row) => [row.slug, row.display_name, row.summary].some((value) => value.toLowerCase().includes(needle)));
  });

  const count = $derived(search.trim() ? `${filtered.length} of ${items.length}` : `${items.length} ${items.length === 1 ? "role" : "roles"}`);
  const href = (row: RoleListRow) => `${base}${libraryRoleHref(row.slug)}`;
</script>

<div class="space-y-3">
  {#if $query.data && !enabled}
    <p class="rounded-md border border-warning/25 bg-warning-muted p-3 text-body-sm text-warning-muted-foreground" role="status">
      Agent roles are off. Agents get no role catalog, no <code class="font-mono">roles</code> Skill and no role guidance, and
      activations are refused. Stored roles and their history are kept. Turn on “Agent roles” above to offer them.
    </p>
  {/if}

  <Toolbar bind:search searchPlaceholder="Search roles by name or summary" {count}>
    {#snippet actions()}
      <Button variant="outline" size="icon" aria-label="Refresh" disabled={$query.isFetching} onclick={() => void $query.refetch()}>
        <RefreshCw class={$query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      </Button>
      <Button onclick={() => (createOpen = true)}>
        <Plus class="h-4 w-4" />
        New role
      </Button>
    {/snippet}
  </Toolbar>

  {#if $query.isError && !$query.data}
    <StateBlock state="error" message={$query.error instanceof Error ? $query.error.message : "Could not load roles"} onRetry={() => void $query.refetch()} />
  {:else}
    <DataTable
      items={filtered}
      loading={$query.isLoading}
      error={null}
      key={(row) => row.slug}
      filtered={search.trim() !== ""}
      onClearFilters={() => (search = "")}
      emptyTitle="No roles yet"
      emptyDescription="A role packages a specialist responsibility — a role prompt plus reference material — that agents take on an explicit assignment."
      caption="Agent roles"
    >
      {#snippet emptyAction()}
        <Button onclick={() => (createOpen = true)}><Plus class="h-4 w-4" />New role</Button>
      {/snippet}
      {#snippet head()}
        <Table.Head>Role</Table.Head>
        <Table.Head>Version</Table.Head>
        <Table.Head class="text-right">Holders</Table.Head>
        <Table.Head>Changes</Table.Head>
        <Table.Head>Updated</Table.Head>
      {/snippet}
      {#snippet row(item)}
        <Table.Row>
          <Table.Cell class="max-w-0 min-w-56">
            <a href={href(item)} class="font-medium hover:underline">{item.display_name}</a>
            <span class="ml-2 font-mono text-caption text-muted-foreground">{item.slug}</span>
            {#if item.status === "retired"}<Badge variant="secondary" class="ml-2">retired</Badge>{/if}
            <div class="truncate text-body-sm text-muted-foreground">{item.summary}</div>
          </Table.Cell>
          <Table.Cell class="whitespace-nowrap">
            {#if item.current_version}v{item.current_version}{:else}<span class="text-muted-foreground">Not published</span>{/if}
          </Table.Cell>
          <Table.Cell class="text-right tabular-nums">{item.holders}</Table.Cell>
          <Table.Cell class="whitespace-nowrap text-body-sm">
            <Badge variant={item.policy.mutation === "autonomous" ? "secondary" : "warning"}>{mutationLabel(item.policy.mutation)}</Badge>
            {#if item.held_proposals}
              <span class="ml-2 text-warning-muted-foreground">{item.held_proposals} held for you</span>
            {:else if item.open_proposals}
              <span class="ml-2 text-muted-foreground">{item.open_proposals} in progress</span>
            {/if}
          </Table.Cell>
          <Table.Cell class="whitespace-nowrap text-body-sm text-muted-foreground" title={item.updated_at}>{relativeTime(item.updated_at)}</Table.Cell>
        </Table.Row>
      {/snippet}
    </DataTable>
  {/if}
</div>

<CreateRoleSheet bind:open={createOpen} onCreated={(slug) => void goto(`${base}${libraryRoleHref(slug)}`)} />

