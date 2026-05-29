<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import { subagentsApi, subagentsKeys } from "$lib/api/subagents";
  import type { ArtifactView } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { CLAUDE_MODELS, INHERIT_MODEL, SUBAGENT_COLORS } from "$lib/constants/models";
  import { asString, asStringArray, modelLabel } from "$lib/utils/artifact";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import * as Select from "$lib/components/ui/select";
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
      queryKey: subagentsKeys.detail(slug),
      queryFn: () => subagentsApi.get(slug),
    })),
  );

  // Local editor state, hydrated when the query resolves.
  let body = $state("");
  let description = $state("");
  let model = $state(INHERIT_MODEL);
  let color = $state("");
  let tools = $state<string[]>([]);
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
      model = data.model ?? INHERIT_MODEL;
      color = asString(data.frontmatter?.color);
      tools = asStringArray(data.frontmatter?.tools);
      serverSha = data.sha256 ?? null;
      hydrated = true;
    }
  });

  const colorValue = $derived(color || "none");
  const modelDisplay = $derived(modelLabel(model));

  // ---- Save ----
  const saveMutation = createMutation({
    mutationFn: () =>
      subagentsApi.store({
        slug,
        description,
        model: model || undefined,
        color: color || undefined,
        tools,
        body,
      }),
    onSuccess: (result) => {
      serverSha = result.sha256 ?? null;
      toast.success(result.status === "unchanged" ? "No changes to save" : `Subagent ${result.status}`);
      void qc.invalidateQueries({ queryKey: subagentsKeys.all });
      void qc.invalidateQueries({ queryKey: subagentsKeys.detail(slug) });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to save");
    },
  });

  // ---- Delete ----
  let deleteOpen = $state(false);
  const deleteMutation = createMutation({
    mutationFn: () => subagentsApi.delete(slug),
    onSuccess: () => {
      toast.success(`Subagent "${slug}" deleted`);
      void qc.invalidateQueries({ queryKey: subagentsKeys.all });
      void goto(`${base}/authoring/subagents`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete");
    },
  });

  const previewFrontmatter = $derived({
    name: slug,
    description,
    model: model || undefined,
    color: color || undefined,
    tools,
  });
</script>

<PageHeader title={$query.data?.display_name || slug} subtitle={`Subagent · ${slug}`}>
  {#snippet actions()}
    <Button variant="outline" href={`${base}/authoring/subagents`}>
      <ArrowLeft class="h-4 w-4" />
      Back
    </Button>
  {/snippet}
</PageHeader>

{#if $query.isLoading}
  <p class="text-sm text-muted-foreground">Loading subagent…</p>
{:else if $query.isError}
  <p class="text-sm text-destructive">
    {$query.error instanceof Error ? $query.error.message : "Failed to load subagent"}
  </p>
{:else}
  <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
    <!-- Editor + preview -->
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between text-sm">
          <span class="font-medium">Body (Markdown)</span>
          {#if serverSha}
            <span class="font-mono text-xs text-muted-foreground" title={serverSha}>
              sha256: {serverSha.slice(0, 12)}…
            </span>
          {/if}
        </div>
        <Textarea
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

    <!-- Side panel -->
    <aside class="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Frontmatter</h3>
        <div class="space-y-3">
          <div class="space-y-1.5">
            <label for="fm-description" class="text-xs font-medium">Description <span class="text-destructive">*</span></label>
            <Textarea id="fm-description" rows={3} bind:value={description} />
          </div>
          <div class="space-y-1.5">
            <label for="fm-model" class="text-xs font-medium">Model</label>
            <Select.Root type="single" value={model} onValueChange={(v) => (model = v ?? INHERIT_MODEL)}>
              <Select.Trigger id="fm-model" class="w-full" aria-label="Model">
                <Select.Value placeholder="Inherit">{modelDisplay}</Select.Value>
              </Select.Trigger>
              <Select.Content>
                {#each CLAUDE_MODELS as m (m.value)}
                  <Select.Item value={m.value} label={m.label}>{m.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="space-y-1.5">
            <label for="fm-color" class="text-xs font-medium">Color</label>
            <Select.Root
              type="single"
              value={colorValue}
              onValueChange={(v) => (color = !v || v === "none" ? "" : v)}
            >
              <Select.Trigger id="fm-color" class="w-full" aria-label="Color">
                <Select.Value placeholder="None">{color || "None"}</Select.Value>
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="none" label="None">None</Select.Item>
                {#each SUBAGENT_COLORS as c (c)}
                  <Select.Item value={c} label={c}>{c}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="space-y-1.5">
            <span class="text-xs font-medium">Tools</span>
            <RepeatableList bind:items={tools} placeholder="tool name" addLabel="Add tool" />
          </div>
        </div>
      </div>

      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Actions</h3>
        <div class="flex flex-col gap-2">
          <Button onclick={() => $saveMutation.mutate()} disabled={$saveMutation.isPending}>
            <Save class="h-4 w-4" />
            {$saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
          <Button variant="destructive" onclick={() => (deleteOpen = true)} disabled={$deleteMutation.isPending}>
            <Trash2 class="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <div class="rounded-lg border bg-card p-4 text-xs">
        <Badge variant={$query.data?.deleted_at ? "destructive" : "success"}>
          {$query.data?.deleted_at ? "deleted" : "active"}
        </Badge>
      </div>
    </aside>
  </div>
{/if}

<!-- Delete confirm -->
<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete subagent</Dialog.Title>
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
