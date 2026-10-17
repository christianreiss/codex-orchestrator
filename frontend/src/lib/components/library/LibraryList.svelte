<script lang="ts">
  /**
   * The one list for every named Library document: search first, then the
   * table, with a single "New …" action. Skills add a secondary import action.
   */
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Download from "@lucide/svelte/icons/download";
  import { ApiError } from "$lib/api/client";
  import { relativeTime } from "$lib/utils/format";
  import { DataTable, Toolbar } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import * as Table from "$lib/components/ui/table";
  import RowActions from "$lib/components/data-table/RowActions.svelte";
  import SortableHead from "$lib/components/data-table/SortableHead.svelte";
  import CreateDocumentSheet from "./CreateDocumentSheet.svelte";
  import SkillSourceSheet from "./SkillSourceSheet.svelte";
  import { libraryDocHref, type DocListConfig, type LibraryRow } from "./library-types";

  let { config }: { config: DocListConfig } = $props();

  const qc = useQueryClient();
  const query = createQuery(
    reactiveOptions(() => ({ queryKey: [...config.listKey], queryFn: () => config.load() })),
  );

  const items = $derived($query.data ?? []);
  let search = $state("");
  let createOpen = $state(false);
  let importOpen = $state(false);
  let deleteTarget = $state<LibraryRow | null>(null);
  let deleteOpen = $state(false);

  const filtered = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((row) => [row.name, row.slug, row.description].some((value) => value?.toLowerCase().includes(needle)));
  });

  type SortKey = "name" | "status" | "updated";
  let sortKey = $state<SortKey>("name");
  let sortDir = $state<"asc" | "desc">("asc");
  function onSort(key: SortKey) {
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else [sortKey, sortDir] = [key, "asc"];
  }
  const sorted = $derived.by(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "status") cmp = a.status.label.localeCompare(b.status.label);
      else cmp = (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "");
      return (cmp || a.slug.localeCompare(b.slug)) * dir;
    });
  });

  const remove = createMutation({
    mutationFn: (slug: string) => config.remove(slug),
    onSuccess: (_data, slug) => {
      toast.success(`${config.singular[0]!.toUpperCase()}${config.singular.slice(1)} "${slug}" deleted`);
      void qc.invalidateQueries({ queryKey: [...config.invalidateKey] });
      deleteOpen = false;
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : `Failed to delete ${config.singular}`),
  });

  const plural = $derived(config.id === "output-styles" ? "reply styles" : config.id);
  const count = $derived(
    search.trim() ? `${sorted.length} of ${items.length}` : `${items.length} ${items.length === 1 ? config.singular : plural}`,
  );
  const href = (row: LibraryRow) => `${base}${libraryDocHref(config.id, row.slug)}`;
</script>

<div class="space-y-3">
  <Toolbar bind:search searchPlaceholder={`Search ${plural} by name or description`} {count}>
    {#snippet actions()}
      <Button variant="outline" size="icon" aria-label="Refresh" disabled={$query.isFetching} onclick={() => void $query.refetch()}>
        <RefreshCw class={$query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      </Button>
      {#if config.id === "skills"}
        <Button variant="outline" onclick={() => (importOpen = true)}>
          <Download class="h-4 w-4" />
          Import from repository
        </Button>
      {/if}
      <Button onclick={() => (createOpen = true)}>
        <Plus class="h-4 w-4" />
        New {config.singular}
      </Button>
    {/snippet}
  </Toolbar>

  <DataTable
    items={sorted}
    loading={$query.isLoading}
    error={$query.isError ? ($query.error instanceof Error ? $query.error.message : `Failed to load ${plural}`) : null}
    onRetry={() => void $query.refetch()}
    key={(row) => row.slug}
    filtered={search.trim() !== "" && items.length > 0}
    emptyTitle={`No ${plural} yet`}
    emptyDescription={config.emptyDescription}
    caption={`${plural} list`}
  >
    {#snippet emptyAction()}
      <Button onclick={() => (createOpen = true)}><Plus class="h-4 w-4" />New {config.singular}</Button>
    {/snippet}
    {#snippet head()}
      <SortableHead label="Name" active={sortKey === "name"} dir={sortDir} onclick={() => onSort("name")} />
      <SortableHead label="Status" active={sortKey === "status"} dir={sortDir} onclick={() => onSort("status")} />
      <SortableHead label="Updated" active={sortKey === "updated"} dir={sortDir} onclick={() => onSort("updated")} />
      <Table.Head class="w-10"><span class="sr-only">Actions</span></Table.Head>
    {/snippet}
    {#snippet row(item)}
      <Table.Row>
        <Table.Cell class="max-w-0 min-w-48">
          <a href={href(item)} class="font-medium hover:underline">{item.name}</a>
          {#if item.name !== item.slug}<span class="ml-2 font-mono text-caption text-muted-foreground">{item.slug}</span>{/if}
          {#if item.description}<div class="truncate text-body-sm text-muted-foreground">{item.description}</div>{/if}
        </Table.Cell>
        <Table.Cell><Badge variant={item.status.variant}>{item.status.label}</Badge></Table.Cell>
        <Table.Cell class="whitespace-nowrap text-body-sm text-muted-foreground">
          {item.updatedAt ? relativeTime(item.updatedAt) : "—"}
        </Table.Cell>
        <Table.Cell class="text-right">
          <RowActions
            label={`Actions for ${item.name}`}
            actions={[
              { label: "Open", icon: ExternalLink, onClick: () => void goto(href(item)) },
              {
                label: "Delete",
                icon: Trash2,
                destructive: true,
                disabled: item.locked,
                reason: item.locked ? "Managed or synchronized, so it cannot be deleted here" : undefined,
                onClick: () => ((deleteTarget = item), (deleteOpen = true)),
              },
            ]}
          />
        </Table.Cell>
      </Table.Row>
    {/snippet}
  </DataTable>
</div>

<CreateDocumentSheet bind:open={createOpen} {config} />
{#if config.id === "skills"}<SkillSourceSheet bind:open={importOpen} />{/if}

<ConfirmDialog
  bind:open={deleteOpen}
  title={`Delete ${config.singular}`}
  description={`${deleteTarget?.slug ?? ""}: ${config.deleteNote}`}
  confirmLabel="Delete"
  destructive
  busy={$remove.isPending}
  onConfirm={() => { if (deleteTarget) $remove.mutate(deleteTarget.slug); }}
/>
