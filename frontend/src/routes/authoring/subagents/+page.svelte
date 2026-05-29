<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import { subagentsApi, subagentsKeys } from "$lib/api/subagents";
  import type { ArtifactView } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { relativeTime } from "$lib/utils/format";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import * as Table from "$lib/components/ui/table";
  import * as Sheet from "$lib/components/ui/sheet";
  import * as Dialog from "$lib/components/ui/dialog";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";

  const qc = useQueryClient();

  const query = createQuery({
    queryKey: subagentsKeys.list(),
    queryFn: () => subagentsApi.list(),
  });

  const items = $derived($query.data?.artifacts ?? []);
  const updatedAt = $derived(
    items
      .map((s) => s.updated_at ?? null)
      .filter((v): v is string => !!v)
      .sort()
      .reverse()[0] ?? null,
  );

  function status(row: ArtifactView): { label: string; variant: "success" | "destructive" } {
    if (row.deleted_at) return { label: "deleted", variant: "destructive" };
    return { label: "active", variant: "success" };
  }

  // ---- New subagent sheet ----
  let createOpen = $state(false);
  let newSlug = $state("");
  let newDescription = $state("");

  const createMut = createMutation({
    mutationFn: (payload: { slug: string; description: string }) =>
      subagentsApi.store({ slug: payload.slug, description: payload.description, body: "" }),
    onSuccess: (data, variables) => {
      toast.success(`Subagent "${variables.slug}" created`);
      void qc.invalidateQueries({ queryKey: subagentsKeys.all });
      createOpen = false;
      newSlug = "";
      newDescription = "";
      void goto(`${base}/authoring/subagents/${encodeURIComponent(data.slug ?? variables.slug)}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to create subagent");
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
    mutationFn: (slug: string) => subagentsApi.delete(slug),
    onSuccess: (_data, slug) => {
      toast.success(`Subagent "${slug}" deleted`);
      void qc.invalidateQueries({ queryKey: subagentsKeys.all });
      deleteTarget = null;
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete subagent");
    },
  });
</script>

<section class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-sm">
  <div class="flex flex-col">
    <span class="text-xs uppercase tracking-wide text-muted-foreground">Subagents</span>
    <span class="text-lg font-semibold">{items.length}</span>
  </div>
  <div class="flex flex-col">
    <span class="text-xs uppercase tracking-wide text-muted-foreground">Last updated</span>
    <span class="text-sm">{updatedAt ? relativeTime(updatedAt) : "—"}</span>
  </div>
  <div class="ml-auto flex items-center gap-2">
    <Button
      variant="outline"
      size="sm"
      onclick={() => void qc.invalidateQueries({ queryKey: subagentsKeys.all })}
      disabled={$query.isFetching}
    >
      <RefreshCw class={$query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      Refresh
    </Button>
    <Button size="sm" onclick={() => (createOpen = true)}>
      <Plus class="h-4 w-4" />
      New subagent
    </Button>
  </div>
</section>

<div class="rounded-lg border bg-card">
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head>Name</Table.Head>
        <Table.Head>Slug</Table.Head>
        <Table.Head>Status</Table.Head>
        <Table.Head>Updated</Table.Head>
        <Table.Head class="text-right">Actions</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#if $query.isLoading}
        <Table.Row>
          <Table.Cell colspan={5} class="py-6 text-center text-sm text-muted-foreground">
            Loading subagents…
          </Table.Cell>
        </Table.Row>
      {:else if $query.isError}
        <Table.Row>
          <Table.Cell colspan={5} class="py-6 text-center text-sm text-destructive">
            {$query.error instanceof Error ? $query.error.message : "Failed to load subagents"}
          </Table.Cell>
        </Table.Row>
      {:else if items.length === 0}
        <Table.Row>
          <Table.Cell colspan={5} class="py-6 text-center text-sm text-muted-foreground">
            No subagents yet. Click "New subagent" to author one.
          </Table.Cell>
        </Table.Row>
      {:else}
        {#each items as row (row.slug)}
          {@const s = status(row)}
          <Table.Row>
            <Table.Cell class="font-medium">
              <a
                href={`${base}/authoring/subagents/${encodeURIComponent(row.slug)}`}
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
                  href={`${base}/authoring/subagents/${encodeURIComponent(row.slug)}`}
                >
                  <ExternalLink class="h-4 w-4" />
                  Open
                </Button>
                <Button variant="ghost" size="sm" onclick={() => (deleteTarget = row)}>
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

<!-- New subagent sheet -->
<Sheet.Root bind:open={createOpen}>
  <Sheet.Content side="right" class="w-full sm:max-w-md">
    <Sheet.Header>
      <Sheet.Title>New subagent</Sheet.Title>
      <Sheet.Description>
        Create an empty subagent. You'll be redirected to the editor on save.
      </Sheet.Description>
    </Sheet.Header>
    <div class="mt-6 space-y-4">
      <div class="space-y-1.5">
        <label for="new-subagent-slug" class="text-sm font-medium">Slug</label>
        <Input
          id="new-subagent-slug"
          placeholder="e.g. code-reviewer"
          bind:value={newSlug}
          autocomplete="off"
        />
        <p class="text-xs text-muted-foreground">Lowercase, hyphens, periods or underscores.</p>
      </div>
      <div class="space-y-1.5">
        <label for="new-subagent-description" class="text-sm font-medium">Description</label>
        <Textarea
          id="new-subagent-description"
          rows={4}
          placeholder="When this subagent should be invoked…"
          bind:value={newDescription}
        />
      </div>
    </div>
    <Sheet.Footer class="mt-6 flex justify-end gap-2">
      <Button variant="outline" onclick={() => (createOpen = false)}>Cancel</Button>
      <Button onclick={handleCreate} disabled={$createMut.isPending}>
        {$createMut.isPending ? "Creating…" : "Create subagent"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

<!-- Delete confirm dialog -->
<Dialog.Root open={!!deleteTarget} onOpenChange={(v) => (v ? null : (deleteTarget = null))}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete subagent</Dialog.Title>
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
