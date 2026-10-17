<script lang="ts">
  /**
   * The skill editor: manifest first with a live preview beside it, metadata
   * and "skill controls" in the collapsed Settings, delete last. Skills that
   * are managed or synchronized from an upstream source are read-only.
   */
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Save from "@lucide/svelte/icons/save";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { skillsApi } from "$lib/api/skills";
  import { MATTPOCOCK_REPOSITORY } from "$lib/api/skillSources";
  import { ApiError } from "$lib/api/client";
  import type { SkillDetail } from "$lib/api/types";
  import { DocumentEditor, PageShell, StateBlock } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { FormField } from "$lib/components/ui/form-field";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import RenderedMarkdown from "$lib/components/authoring/RenderedMarkdown.svelte";
  import AiAssistDialog from "./AiAssistDialog.svelte";

  let { slug }: { slug: string } = $props();

  const qc = useQueryClient();
  const listHref = `${base}/library`;

  const query = createQuery<SkillDetail>(
    reactiveOptions(() => ({ queryKey: ["skills", slug] as readonly string[], queryFn: () => skillsApi.get(slug) })),
  );

  let manifest = $state("");
  let displayName = $state("");
  let description = $state("");
  let serverSha = $state<string | null>(null);
  let hydrated = $state(false);

  $effect(() => {
    const data = $query.data;
    if (!data || hydrated) return;
    manifest = data.manifest ?? "";
    displayName = data.display_name ?? "";
    description = data.description ?? "";
    serverSha = data.sha256 ?? null;
    hydrated = true;
  });

  const sourceType = $derived($query.data?.source_type?.trim() || null);
  const isMattPocock = $derived(sourceType?.toLowerCase().includes("mattpocock") ?? false);
  const sourceLabel = $derived(isMattPocock ? "Matt Pocock" : sourceType);
  const isManaged = $derived($query.data?.managed === true || sourceType !== null);

  const save = createMutation({
    mutationFn: () => skillsApi.store({ slug, manifest, display_name: displayName, description }),
    onSuccess: (result) => {
      serverSha = result.sha256 ?? null;
      toast.success(result.status === "unchanged" ? "No changes to save" : `Skill ${result.status}`);
      void qc.invalidateQueries({ queryKey: ["skills"] });
      void qc.invalidateQueries({ queryKey: ["skills", slug] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to save"),
  });

  let deleteOpen = $state(false);
  const remove = createMutation({
    mutationFn: () => skillsApi.delete(slug),
    onSuccess: () => {
      toast.success(`Skill "${slug}" deleted`);
      void qc.invalidateQueries({ queryKey: ["skills"] });
      void goto(listHref);
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to delete"),
  });

  let assistOpen = $state(false);
  function applyDraft(result: { manifest?: string; display_name?: string; description?: string }) {
    manifest = result.manifest ?? manifest;
    if (result.display_name && !displayName) displayName = result.display_name;
    if (result.description && !description) description = result.description;
  }

  const metadata = $derived(
    [
      { label: "sha256", value: serverSha ? `${serverSha.slice(0, 12)}…` : null, title: serverSha ?? undefined, mono: true },
      { label: "URI", value: $query.data?.uri ?? null, mono: true },
      { label: "Upstream revision", value: $query.data?.source_revision ? `${$query.data.source_revision.slice(0, 12)}…` : null, title: $query.data?.source_revision ?? undefined, mono: true },
      { label: "Source path", value: $query.data?.source_path ?? null, mono: true },
      { label: "License", value: $query.data?.source_license ?? null, mono: false },
    ].filter((item) => item.value),
  );
</script>

{#if $query.isLoading}
  <PageShell title={slug} description="skill"><StateBlock state="loading" /></PageShell>
{:else if $query.isError}
  <PageShell title={slug} description="skill">
    <StateBlock state="error" message={$query.error instanceof Error ? $query.error.message : "Failed to load skill"} onRetry={() => void $query.refetch()} />
  </PageShell>
{:else}
  <DocumentEditor title={displayName || slug} description={`skill · ${slug}`}>
    {#snippet actions()}
      <Button variant="outline" href={listHref}><ArrowLeft class="h-4 w-4" />Back</Button>
      <Button variant="outline" onclick={() => (assistOpen = true)} disabled={isManaged}>
        <Sparkles class="h-4 w-4" />
        AI assist
      </Button>
      <Button onclick={() => $save.mutate()} disabled={$save.isPending || isManaged}>
        <Save class="h-4 w-4" />
        {$save.isPending ? "Saving…" : "Save"}
      </Button>
    {/snippet}
    {#snippet body()}
      <div class="space-y-2">
        {#if isManaged}
          <p class="rounded-md border border-warning/25 bg-warning-muted p-3 text-body-sm text-warning-muted-foreground">
            {#if sourceType}
              This skill is synchronized from
              {#if isMattPocock}
                <a href={MATTPOCOCK_REPOSITORY} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 font-medium underline underline-offset-2">
                  mattpocock/skills
                  <ExternalLink class="h-3 w-3" />
                </a>
              {:else}
                <span class="font-medium">{sourceType}</span>
              {/if}
              and is read-only here.
            {:else}
              This skill is managed by the system and cannot be edited or deleted.
            {/if}
          </p>
        {/if}
        <span class="text-body font-medium">Manifest (Markdown)</span>
        <Textarea
          aria-label="Skill manifest"
          class="min-h-[60vh] resize-y font-mono text-body-sm leading-relaxed"
          spellcheck="false"
          autocomplete="off"
          bind:value={manifest}
          readonly={isManaged}
        />
        <p class="text-body-sm text-muted-foreground">The manifest is the source of truth. Saving updates the sha256.</p>
      </div>
    {/snippet}
    {#snippet preview()}
      <div class="space-y-2">
        <span class="text-body font-medium">Rendered preview</span>
        <RenderedMarkdown source={manifest} />
      </div>
    {/snippet}
    {#snippet settings()}
      <div role="group" aria-label="Skill controls" class="space-y-3">
        <Badge variant={isManaged ? "secondary" : "success"}>{sourceLabel ?? (isManaged ? "managed" : "active")}</Badge>
        <FormField id="meta-display-name" label="Display name">
          <Input id="meta-display-name" bind:value={displayName} disabled={isManaged} />
        </FormField>
        <FormField id="meta-description" label="Description">
          <Textarea id="meta-description" rows={3} bind:value={description} disabled={isManaged} />
        </FormField>
        {#if metadata.length}
          <dl class="grid gap-x-4 gap-y-2 border-t pt-3 text-body-sm sm:grid-cols-2">
            {#each metadata as item (item.label)}
              <div class="min-w-0">
                <dt class="text-muted-foreground">{item.label}</dt>
                <dd class={item.mono ? "break-all font-mono" : undefined} title={item.title}>{item.value}</dd>
              </div>
            {/each}
          </dl>
        {/if}
      </div>
    {/snippet}
    {#snippet danger()}
      <p class="mb-2 text-body-sm text-muted-foreground">Soft-delete this skill. You can re-create it with the same slug later.</p>
      <Button variant="destructive" onclick={() => (deleteOpen = true)} disabled={$remove.isPending || isManaged}>
        <Trash2 class="h-4 w-4" />
        Delete skill
      </Button>
    {/snippet}
  </DocumentEditor>
{/if}

<AiAssistDialog
  bind:open={assistOpen}
  skill={{ slug, manifest, displayName, description }}
  onDraft={applyDraft}
  onApplyManifest={(next) => (manifest = next)}
/>

<ConfirmDialog
  bind:open={deleteOpen}
  title="Delete skill"
  description={`This will soft-delete ${slug}. The action is reversible by re-creating the skill with the same slug.`}
  confirmLabel="Delete"
  destructive
  busy={$remove.isPending}
  onConfirm={() => $remove.mutate()}
/>
