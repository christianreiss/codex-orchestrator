<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import { commandsApi, commandsKeys } from "$lib/api/commands";
  import type { ArtifactView } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { CLAUDE_MODELS, INHERIT_MODEL } from "$lib/constants/models";
  import { asString, asStringArray } from "$lib/utils/artifact";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import DangerZone from "$lib/components/layout/DangerZone.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import * as Card from "$lib/components/ui/card";
  import { ModelSelect } from "$lib/components/ui/model-select";
  import * as Dialog from "$lib/components/ui/dialog";
  import RepeatableList from "$lib/components/authoring/RepeatableList.svelte";
  import MdPreview from "$lib/components/authoring/MdPreview.svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Save from "@lucide/svelte/icons/save";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  const qc = useQueryClient();
  const slug = $derived(page.params.name ?? "");

  const query = createQuery<ArtifactView>(
    reactiveOptions(() => ({
      queryKey: commandsKeys.detail(slug),
      queryFn: () => commandsApi.get(slug),
    })),
  );

  let body = $state("");
  let description = $state("");
  let argumentHint = $state("");
  let model = $state(INHERIT_MODEL);
  let allowedTools = $state<string[]>([]);
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
      argumentHint = asString(data.frontmatter?.argument_hint);
      model = data.model || INHERIT_MODEL;
      allowedTools = asStringArray(data.frontmatter?.allowed_tools);
      serverSha = data.sha256 ?? null;
      hydrated = true;
    }
  });

  // ---- Save ----
  const saveMutation = createMutation({
    mutationFn: () =>
      commandsApi.store({
        slug,
        description,
        argument_hint: argumentHint || undefined,
        model: model === INHERIT_MODEL ? undefined : model,
        allowed_tools: allowedTools,
        body,
      }),
    onSuccess: (result) => {
      serverSha = result.sha256 ?? null;
      toast.success(result.status === "unchanged" ? "No changes to save" : `Command ${result.status}`);
      void qc.invalidateQueries({ queryKey: commandsKeys.all });
      void qc.invalidateQueries({ queryKey: commandsKeys.detail(slug) });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to save");
    },
  });

  // ---- Delete ----
  let deleteOpen = $state(false);
  const deleteMutation = createMutation({
    mutationFn: () => commandsApi.delete(slug),
    onSuccess: () => {
      toast.success(`Command "${slug}" deleted`);
      void qc.invalidateQueries({ queryKey: commandsKeys.all });
      void goto(`${base}/commands`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete");
    },
  });

  const previewFrontmatter = $derived({
    description,
    "argument-hint": argumentHint || undefined,
    model: model === INHERIT_MODEL ? undefined : model,
    "allowed-tools": allowedTools,
  });
</script>

<PageHeader title={$query.data?.display_name || slug} subtitle={`Command · ${slug}`}>
  {#snippet actions()}
    <Button variant="outline" href={`${base}/commands`}>
      <ArrowLeft class="h-4 w-4" />
      Back
    </Button>
  {/snippet}
</PageHeader>

{#if $query.isLoading}
  <p class="text-sm text-muted-foreground">Loading command…</p>
{:else if $query.isError}
  <p class="text-sm text-destructive">
    {$query.error instanceof Error ? $query.error.message : "Failed to load command"}
  </p>
{:else}
  <div class="flex flex-col gap-6">
    <!-- Editor + preview -->
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-3">
        <span class="text-sm font-medium">Body (Markdown)</span>
        <Textarea
          aria-label="Command body"
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

    <aside aria-label="Command controls" class="border-t pt-5">
      <Card.Root>
        <Card.Header class="flex-row items-center justify-between gap-2 space-y-0">
          <Card.Title class="text-sm">Frontmatter</Card.Title>
          <Badge variant={$query.data?.deleted_at ? "destructive" : "success"}>
            {$query.data?.deleted_at ? "deleted" : "active"}
          </Badge>
        </Card.Header>
        <Card.Content class="space-y-3">
          <div class="space-y-1.5">
            <label for="fm-description" class="text-xs font-medium">Description <span class="text-destructive">*</span></label>
            <Textarea id="fm-description" rows={3} bind:value={description} />
          </div>
          <div class="space-y-1.5">
            <label for="fm-argument-hint" class="text-xs font-medium">Argument hint</label>
            <Input id="fm-argument-hint" bind:value={argumentHint} placeholder="e.g. [pr-number]" />
          </div>
          <div class="space-y-1.5">
            <label for="fm-model" class="text-xs font-medium">Model</label>
            <ModelSelect bind:value={model} options={CLAUDE_MODELS} label="Model" placeholder="Inherit" fallback={INHERIT_MODEL} />
          </div>
          <div class="space-y-1.5">
            <span class="text-xs font-medium">Allowed tools</span>
            <RepeatableList bind:items={allowedTools} placeholder="tool name" addLabel="Add tool" />
          </div>
          {#if serverSha}
            <p class="border-t pt-3 font-mono text-[11px] text-muted-foreground" title={serverSha}>
              sha256: {serverSha.slice(0, 12)}…
            </p>
          {/if}
        </Card.Content>
      </Card.Root>

      <div class="mt-3 flex items-center justify-end gap-3 border-t px-1 pt-3">
        <Button onclick={() => $saveMutation.mutate()} disabled={$saveMutation.isPending}>
          <Save class="h-4 w-4" />
          {$saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </aside>
  </div>

  <DangerZone description="Permanently remove this command. You can re-create it with the same slug later.">
    <Button variant="destructive" onclick={() => (deleteOpen = true)} disabled={$deleteMutation.isPending}>
      <Trash2 class="h-4 w-4" />
      Delete command
    </Button>
  </DangerZone>
{/if}

<!-- Delete confirm -->
<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete command</Dialog.Title>
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
