<script lang="ts">
  /**
   * The document editor for the three Claude-native types (subagents, commands,
   * reply styles). Body first, front matter in the collapsed Settings, delete
   * last. Fields differ per type; everything else is shared.
   */
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import Save from "@lucide/svelte/icons/save";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { ApiError } from "$lib/api/client";
  import type { ArtifactStorePayload, ArtifactView } from "$lib/api/types";
  import { CLAUDE_MODELS, INHERIT_MODEL, SUBAGENT_COLORS } from "$lib/constants/models";
  import { asString, asStringArray } from "$lib/utils/artifact";
  import { DocumentEditor, PageShell, StateBlock } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { FormField } from "$lib/components/ui/form-field";
  import { Input } from "$lib/components/ui/input";
  import { ModelSelect } from "$lib/components/ui/model-select";
  import * as Select from "$lib/components/ui/select";
  import { Textarea } from "$lib/components/ui/textarea";
  import RepeatableList from "$lib/components/authoring/RepeatableList.svelte";
  import MdPreview from "$lib/components/authoring/MdPreview.svelte";
  import { ARTIFACT_APIS, DOC_LISTS, libraryListHref, type ArtifactTypeId } from "./library-types";

  let { type, slug }: { type: ArtifactTypeId; slug: string } = $props();

  const qc = useQueryClient();
  const cfg = $derived(ARTIFACT_APIS[type]);
  const singular = $derived(DOC_LISTS[type].singular);
  const listHref = $derived(`${base}${libraryListHref(type)}`);

  const query = createQuery<ArtifactView>(
    reactiveOptions(() => ({ queryKey: cfg.keys.detail(slug), queryFn: () => cfg.api.get(slug) })),
  );

  let markdown = $state("");
  let description = $state("");
  let model = $state(INHERIT_MODEL);
  let color = $state("");
  let tools = $state<string[]>([]);
  let argumentHint = $state("");
  let serverSha = $state<string | null>(null);
  let hydrated = $state(false);

  $effect(() => {
    const data = $query.data;
    if (!data || hydrated) return;
    markdown = data.body ?? "";
    description = data.description ?? "";
    model = data.model || INHERIT_MODEL;
    color = asString(data.frontmatter?.color);
    tools = asStringArray(type === "commands" ? data.frontmatter?.allowed_tools : data.frontmatter?.tools);
    argumentHint = asString(data.frontmatter?.argument_hint);
    serverSha = data.sha256 ?? null;
    hydrated = true;
  });

  const hasModel = $derived(type !== "output-styles");
  const colorValue = $derived(color || "none");

  const save = createMutation({
    mutationFn: () => {
      const payload: ArtifactStorePayload = { slug, description };
      if (hasModel) payload.model = model === INHERIT_MODEL ? undefined : model;
      if (type === "subagents") {
        payload.color = color || undefined;
        payload.tools = tools;
      }
      if (type === "commands") {
        payload.argument_hint = argumentHint || undefined;
        payload.allowed_tools = tools;
      }
      payload.body = markdown;
      return cfg.api.store(payload);
    },
    onSuccess: (result) => {
      serverSha = result.sha256 ?? null;
      toast.success(result.status === "unchanged" ? "No changes to save" : `${singular[0]!.toUpperCase()}${singular.slice(1)} ${result.status}`);
      void qc.invalidateQueries({ queryKey: [...cfg.keys.all] });
      void qc.invalidateQueries({ queryKey: [...cfg.keys.detail(slug)] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to save"),
  });

  let deleteOpen = $state(false);
  const remove = createMutation({
    mutationFn: () => cfg.api.delete(slug),
    onSuccess: () => {
      toast.success(`${singular[0]!.toUpperCase()}${singular.slice(1)} "${slug}" deleted`);
      void qc.invalidateQueries({ queryKey: [...cfg.keys.all] });
      void goto(listHref);
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to delete"),
  });

  const previewFrontmatter = $derived.by<Record<string, unknown>>(() => {
    const inherit = model === INHERIT_MODEL ? undefined : model;
    if (type === "subagents") return { name: slug, description, model: inherit, color: color || undefined, tools };
    if (type === "commands") return { description, "argument-hint": argumentHint || undefined, model: inherit, "allowed-tools": tools };
    return { name: slug, description };
  });
</script>

{#if $query.isLoading}
  <PageShell title={slug} description={singular}><StateBlock state="loading" /></PageShell>
{:else if $query.isError}
  <PageShell title={slug} description={singular}>
    <StateBlock state="error" message={$query.error instanceof Error ? $query.error.message : `Failed to load ${singular}`} onRetry={() => void $query.refetch()} />
  </PageShell>
{:else}
  <DocumentEditor title={$query.data?.display_name || slug} description={`${singular} · ${slug}`}>
    {#snippet actions()}
      <Button variant="outline" href={listHref}><ArrowLeft class="h-4 w-4" />Back</Button>
      <Button onclick={() => $save.mutate()} disabled={$save.isPending}>
        <Save class="h-4 w-4" />
        {$save.isPending ? "Saving…" : "Save"}
      </Button>
    {/snippet}
    {#snippet body()}
      <div class="space-y-2">
        <span class="text-body font-medium">Body (Markdown)</span>
        <Textarea
          aria-label={`${singular[0]!.toUpperCase()}${singular.slice(1)} body`}
          class="min-h-[60vh] resize-y font-mono text-body-sm leading-relaxed"
          spellcheck="false"
          autocomplete="off"
          bind:value={markdown}
        />
      </div>
    {/snippet}
    {#snippet preview()}
      <div class="space-y-2">
        <span class="text-body font-medium">Generated .md preview</span>
        <MdPreview frontmatter={previewFrontmatter} body={markdown} />
      </div>
    {/snippet}
    {#snippet settings()}
      <div role="group" aria-label={`${singular[0]!.toUpperCase()}${singular.slice(1)} controls`} class="space-y-3">
        <Badge variant={$query.data?.deleted_at ? "destructive" : "success"}>{$query.data?.deleted_at ? "deleted" : "active"}</Badge>
        <FormField id="fm-description" label="Description" required={type !== "output-styles"}>
          <Textarea id="fm-description" rows={3} bind:value={description} />
        </FormField>
        {#if type === "commands"}
          <FormField id="fm-argument-hint" label="Argument hint">
            <Input id="fm-argument-hint" bind:value={argumentHint} placeholder="e.g. [pr-number]" />
          </FormField>
        {/if}
        {#if hasModel}
          <FormField id="fm-model" label="Model">
            <ModelSelect bind:value={model} options={CLAUDE_MODELS} label="Model" placeholder="Inherit" fallback={INHERIT_MODEL} />
          </FormField>
        {/if}
        {#if type === "subagents"}
          <FormField id="fm-color" label="Color">
            <Select.Root type="single" value={colorValue} onValueChange={(v) => (color = !v || v === "none" ? "" : v)}>
              <Select.Trigger id="fm-color" class="w-full" aria-label="Color">
                <Select.Value placeholder="None">{color || "None"}</Select.Value>
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="none" label="None">None</Select.Item>
                {#each SUBAGENT_COLORS as c (c)}<Select.Item value={c} label={c}>{c}</Select.Item>{/each}
              </Select.Content>
            </Select.Root>
          </FormField>
        {/if}
        {#if type === "subagents" || type === "commands"}
          <div class="space-y-1.5">
            <span class="text-body-sm font-medium">{type === "commands" ? "Allowed tools" : "Tools"}</span>
            <RepeatableList bind:items={tools} placeholder="tool name" addLabel="Add tool" />
          </div>
        {/if}
        {#if serverSha}
          <p class="border-t pt-3 font-mono text-caption text-muted-foreground" title={serverSha}>sha256: {serverSha.slice(0, 12)}…</p>
        {/if}
      </div>
    {/snippet}
    {#snippet danger()}
      <p class="mb-2 text-body-sm text-muted-foreground">Permanently remove this {singular}. You can re-create it with the same slug later.</p>
      <Button variant="destructive" onclick={() => (deleteOpen = true)} disabled={$remove.isPending}>
        <Trash2 class="h-4 w-4" />
        Delete {singular}
      </Button>
    {/snippet}
  </DocumentEditor>
{/if}

<ConfirmDialog
  bind:open={deleteOpen}
  title={`Delete ${singular}`}
  description={`This will delete ${slug}. You can re-create it with the same slug later.`}
  confirmLabel="Delete"
  destructive
  busy={$remove.isPending}
  onConfirm={() => $remove.mutate()}
/>
