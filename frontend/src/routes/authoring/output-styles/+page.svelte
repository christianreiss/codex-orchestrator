<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import { outputStylesApi, outputStylesKeys } from "$lib/api/outputStyles";
  import type { ArtifactView } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { relativeTime } from "$lib/utils/format";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import * as Table from "$lib/components/ui/table";
  import * as Sheet from "$lib/components/ui/sheet";
  import * as Dialog from "$lib/components/ui/dialog";
  import SortableHead from "$lib/components/data-table/SortableHead.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Search from "@lucide/svelte/icons/search";
  import Palette from "@lucide/svelte/icons/palette";

  const qc = useQueryClient();

  const query = createQuery({
    queryKey: outputStylesKeys.list(),
    queryFn: () => outputStylesApi.list(),
  });

  const items = $derived($query.data?.artifacts ?? []);

  function status(row: ArtifactView): { label: string; variant: "success" | "destructive" } {
    if (row.deleted_at) return { label: "deleted", variant: "destructive" };
    return { label: "active", variant: "success" };
  }

  // ---- Search ----
  let search = $state("");
  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((row) =>
      [row.display_name, row.slug, row.description].some((v) => v?.toLowerCase().includes(q)),
    );
  });

  // ---- Sort ----
  type SortKey = "name" | "status" | "updated";
  let sortKey = $state<SortKey>("name");
  let sortDir = $state<"asc" | "desc">("asc");
  function onSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
  }
  const sorted = $derived.by(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = (a.display_name || a.slug).localeCompare(b.display_name || b.slug);
          break;
        case "status":
          cmp = Number(!!a.deleted_at) - Number(!!b.deleted_at);
          break;
        case "updated":
          cmp = (a.updated_at ?? "").localeCompare(b.updated_at ?? "");
          break;
      }
      if (cmp === 0) cmp = a.slug.localeCompare(b.slug);
      return cmp * dir;
    });
  });

  // ---- New output style sheet ----
  let createOpen = $state(false);
  let newSlug = $state("");
  let newDescription = $state("");

  const createMut = createMutation({
    mutationFn: (payload: { slug: string; description: string }) =>
      outputStylesApi.store({ slug: payload.slug, description: payload.description, body: "" }),
    onSuccess: (data, variables) => {
      toast.success(`Output style "${variables.slug}" created`);
      void qc.invalidateQueries({ queryKey: outputStylesKeys.all });
      createOpen = false;
      newSlug = "";
      newDescription = "";
      void goto(`${base}/authoring/output-styles/${encodeURIComponent(data.slug ?? variables.slug)}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to create output style");
    },
  });

  function handleCreate() {
    const slug = newSlug.trim();
    if (!slug) {
      toast.error("Slug is required");
      return;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
      toast.error("Slug must be alphanumeric with . _ - separators");
      return;
    }
    $createMut.mutate({ slug, description: newDescription.trim() });
  }

  // ---- Delete confirm ----
  let deleteTarget: ArtifactView | null = $state(null);
  const deleteMut = createMutation({
    mutationFn: (slug: string) => outputStylesApi.delete(slug),
    onSuccess: (_data, slug) => {
      toast.success(`Output style "${slug}" deleted`);
      void qc.invalidateQueries({ queryKey: outputStylesKeys.all });
      deleteTarget = null;
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete output style");
    },
  });
</script>

<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div class="relative w-full sm:max-w-sm">
    <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    <Input
      bind:value={search}
      placeholder="Search by name, slug, description..."
      class="pl-9"
      aria-label="Search output styles"
    />
  </div>
  <div class="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
    <p class="mr-1 text-xs text-muted-foreground">
      {#if search.trim()}
        Showing {sorted.length} of {items.length}
      {:else}
        {items.length} {items.length === 1 ? "output style" : "output styles"}
      {/if}
    </p>
    <Button
      variant="outline"
      size="icon"
      aria-label="Refresh"
      onclick={() => void qc.invalidateQueries({ queryKey: outputStylesKeys.all })}
      disabled={$query.isFetching}
    >
      <RefreshCw class={$query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
    </Button>
    <Button size="sm" onclick={() => (createOpen = true)}>
      <Plus class="h-4 w-4" />
      New output style
    </Button>
  </div>
</div>

<div class="overflow-hidden rounded-xl border border-border/75 bg-card shadow-sm">
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <SortableHead label="Name" active={sortKey === "name"} dir={sortDir} onclick={() => onSort("name")} />
        <Table.Head>Slug</Table.Head>
        <SortableHead label="Status" active={sortKey === "status"} dir={sortDir} onclick={() => onSort("status")} />
        <SortableHead
          label="Updated"
          active={sortKey === "updated"}
          dir={sortDir}
          onclick={() => onSort("updated")}
        />
        <Table.Head class="text-right">Actions</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#if $query.isLoading}
        <Table.Row>
          <Table.Cell colspan={5} class="py-6 text-center text-sm text-muted-foreground">
            Loading output styles…
          </Table.Cell>
        </Table.Row>
      {:else if $query.isError}
        <Table.Row>
          <Table.Cell colspan={5} class="py-6 text-center text-sm text-destructive">
            {$query.error instanceof Error ? $query.error.message : "Failed to load output styles"}
          </Table.Cell>
        </Table.Row>
      {:else if items.length === 0}
        <Table.Row>
          <Table.Cell colspan={5}>
            <EmptyState
              icon={Palette}
              size="sm"
              title="No output styles yet"
              description="Output styles change how Claude formats and phrases its responses."
            >
              {#snippet action()}
                <Button size="sm" onclick={() => (createOpen = true)}>
                  <Plus class="h-4 w-4" />
                  New output style
                </Button>
              {/snippet}
            </EmptyState>
          </Table.Cell>
        </Table.Row>
      {:else if sorted.length === 0}
        <Table.Row>
          <Table.Cell colspan={5}>
            <EmptyState
              icon={Search}
              size="sm"
              title={`No output styles match "${search.trim()}"`}
              description="Try a different search."
            >
              {#snippet action()}
                <Button size="sm" variant="outline" onclick={() => (search = "")}>Clear search</Button>
              {/snippet}
            </EmptyState>
          </Table.Cell>
        </Table.Row>
      {:else}
        {#each sorted as row (row.slug)}
          {@const s = status(row)}
          <Table.Row>
            <Table.Cell class="font-medium">
              <a
                href={`${base}/authoring/output-styles/${encodeURIComponent(row.slug)}`}
                class="hover:underline"
              >
                {row.display_name || row.slug}
              </a>
              {#if row.description}
                <div class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{row.description}</div>
              {/if}
            </Table.Cell>
            <Table.Cell class="font-mono text-xs">{row.slug}</Table.Cell>
            <Table.Cell>
              <Badge variant={s.variant}>{s.label}</Badge>
            </Table.Cell>
            <Table.Cell class="text-sm text-muted-foreground">
              {row.updated_at ? relativeTime(row.updated_at) : "—"}
            </Table.Cell>
            <Table.Cell class="text-right">
              <div class="inline-flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  href={`${base}/authoring/output-styles/${encodeURIComponent(row.slug)}`}
                >
                  <ExternalLink class="h-4 w-4" />
                  Open
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete output style ${row.display_name || row.slug}`}
                  onclick={() => (deleteTarget = row)}
                >
                  <Trash2 class="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </Table.Cell>
          </Table.Row>
        {/each}
      {/if}
    </Table.Body>
  </Table.Root>
</div>

<!-- New output style sheet -->
<Sheet.Root bind:open={createOpen}>
  <Sheet.Content side="right" class="w-full sm:max-w-md">
    <Sheet.Header>
      <Sheet.Title>New output style</Sheet.Title>
      <Sheet.Description>
        Create an empty output style. You'll be redirected to the editor on save.
      </Sheet.Description>
    </Sheet.Header>
    <div class="mt-6 space-y-4">
      <div class="space-y-1.5">
        <label for="new-output-style-slug" class="text-sm font-medium">Slug</label>
        <Input
          id="new-output-style-slug"
          placeholder="e.g. concise"
          bind:value={newSlug}
          autocomplete="off"
        />
        <p class="text-xs text-muted-foreground">Lowercase, hyphens, periods or underscores.</p>
      </div>
      <div class="space-y-1.5">
        <label for="new-output-style-description" class="text-sm font-medium">Description</label>
        <Textarea
          id="new-output-style-description"
          rows={4}
          placeholder="What this output style changes…"
          bind:value={newDescription}
        />
      </div>
    </div>
    <Sheet.Footer class="mt-6 flex justify-end gap-2">
      <Button variant="outline" onclick={() => (createOpen = false)}>Cancel</Button>
      <Button onclick={handleCreate} disabled={$createMut.isPending}>
        {$createMut.isPending ? "Creating…" : "Create output style"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

<!-- Delete confirm dialog -->
<Dialog.Root open={!!deleteTarget} onOpenChange={(v) => (v ? null : (deleteTarget = null))}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete output style</Dialog.Title>
      <Dialog.Description>
        This will delete <span class="font-mono">{deleteTarget?.slug}</span>. You can re-create it
        with the same slug later.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="flex justify-end gap-2">
      <Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
      <Button
        variant="destructive"
        disabled={$deleteMut.isPending}
        onclick={() => deleteTarget && $deleteMut.mutate(deleteTarget.slug)}
      >
        {$deleteMut.isPending ? "Deleting…" : "Delete"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
