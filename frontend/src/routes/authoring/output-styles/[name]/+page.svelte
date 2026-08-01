<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import { outputStylesApi, outputStylesKeys } from "$lib/api/outputStyles";
  import type { ArtifactView } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import DangerZone from "$lib/components/layout/DangerZone.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import MdPreview from "$lib/components/authoring/MdPreview.svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Save from "@lucide/svelte/icons/save";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  const qc = useQueryClient();
  const slug = $derived(page.params.name ?? "");

  const query = createQuery<ArtifactView>(
    reactiveOptions(() => ({
      queryKey: outputStylesKeys.detail(slug),
      queryFn: () => outputStylesApi.get(slug),
    })),
  );

  let body = $state("");
  let description = $state("");
  let serverSha = $state<string | null>(null);
  let hydrated = $state(false);

  $effect(() => {
    void slug;
    hydrated = false;
  });

  $effect(() => {
    const data = $query.data;
    if (data && !hydrated) {
      body = data.body ?? "";
      description = data.description ?? "";
      serverSha = data.sha256 ?? null;
      hydrated = true;
    }
  });

  // ---- Save ----
  const saveMutation = createMutation({
    mutationFn: () => outputStylesApi.store({ slug, description, body }),
    onSuccess: (result) => {
      serverSha = result.sha256 ?? null;
      toast.success(result.status === "unchanged" ? "No changes to save" : `Output style ${result.status}`);
      void qc.invalidateQueries({ queryKey: outputStylesKeys.all });
      void qc.invalidateQueries({ queryKey: outputStylesKeys.detail(slug) });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to save");
    },
  });

  // ---- Delete ----
  let deleteOpen = $state(false);
  const deleteMutation = createMutation({
    mutationFn: () => outputStylesApi.delete(slug),
    onSuccess: () => {
      toast.success(`Output style "${slug}" deleted`);
      void qc.invalidateQueries({ queryKey: outputStylesKeys.all });
      void goto(`${base}/authoring/output-styles`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete");
    },
  });

  const previewFrontmatter = $derived({ name: slug, description });
</script>

<PageHeader title={$query.data?.display_name || slug} subtitle={`Output style · ${slug}`} headingLevel="h2">
  {#snippet actions()}
    <Button variant="outline" href={`${base}/authoring/output-styles`}>
      <ArrowLeft class="h-4 w-4" />
      Back
    </Button>
  {/snippet}
</PageHeader>

{#if $query.isLoading}
  <p class="text-sm text-muted-foreground">Loading output style…</p>
{:else if $query.isError}
  <p class="text-sm text-destructive">
    {$query.error instanceof Error ? $query.error.message : "Failed to load output style"}
  </p>
{:else}
  <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
    <!-- Editor + preview -->
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-3">
        <span class="text-sm font-medium">Body (Markdown)</span>
        <Textarea
          aria-label="Output style body"
          class="min-h-[60vh] resize-y font-mono text-sm leading-relaxed"
          spellcheck="false"
          autocomplete="off"
          bind:value={body}
        />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium">Generated .md preview</span>
        <MdPreview frontmatter={previewFrontmatter} {body} />
      </div>
    </div>

    <!-- Side panel: one consolidated card, not three. -->
    <aside aria-label="Output style controls" class="flex flex-col lg:sticky lg:top-6 lg:self-start">
      <Card.Root>
        <Card.Header class="flex-row items-center justify-between gap-2 space-y-0">
          <Card.Title class="text-sm">Frontmatter</Card.Title>
          <Badge variant={$query.data?.deleted_at ? "destructive" : "success"}>
            {$query.data?.deleted_at ? "deleted" : "active"}
          </Badge>
        </Card.Header>
        <Card.Content class="space-y-3">
          <div class="space-y-1.5">
            <label for="fm-description" class="text-xs font-medium">Description</label>
            <Textarea id="fm-description" rows={3} bind:value={description} />
          </div>
          {#if serverSha}
            <p class="border-t pt-3 font-mono text-[11px] text-muted-foreground" title={serverSha}>
              sha256: {serverSha.slice(0, 12)}…
            </p>
          {/if}
        </Card.Content>
      </Card.Root>

      <!-- Rides along in the same sticky context as the card above, so Save
           stays reachable while scrolling the long body textarea without a
           second, competing sticky element. -->
      <div class="mt-3 flex items-center justify-end gap-3 rounded-lg border bg-card px-4 py-3 shadow-pop">
        <Button onclick={() => $saveMutation.mutate()} disabled={$saveMutation.isPending}>
          <Save class="h-4 w-4" />
          {$saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </aside>
  </div>

  <DangerZone description="Permanently remove this output style. You can re-create it with the same slug later.">
    <Button variant="destructive" onclick={() => (deleteOpen = true)} disabled={$deleteMutation.isPending}>
      <Trash2 class="h-4 w-4" />
      Delete output style
    </Button>
  </DangerZone>
{/if}

<!-- Delete confirm -->
<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete output style</Dialog.Title>
      <Dialog.Description>
        This will delete <span class="font-mono">{slug}</span>. You can re-create it with the same
        slug later.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="flex justify-end gap-2">
      <Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
      <Button variant="destructive" disabled={$deleteMutation.isPending} onclick={() => $deleteMutation.mutate()}>
        {$deleteMutation.isPending ? "Deleting…" : "Delete"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
