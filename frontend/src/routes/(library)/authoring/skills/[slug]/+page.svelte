<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { writable } from "svelte/store";
  import { toast } from "svelte-sonner";
  import { skillsApi } from "$lib/api/skills";
  import { MATTPOCOCK_REPOSITORY } from "$lib/api/skillSources";
  import type { SkillDetail } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import DangerZone from "$lib/components/layout/DangerZone.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import RenderedMarkdown from "$lib/components/authoring/RenderedMarkdown.svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Save from "@lucide/svelte/icons/save";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Wand2 from "@lucide/svelte/icons/wand-2";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ExternalLink from "@lucide/svelte/icons/external-link";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  // svelte-query takes a Readable<options> for reactive query keys.
  function buildOptions(s: string) {
    return {
      queryKey: ["skills", s] as readonly string[],
      queryFn: () => skillsApi.get(s),
    };
  }
  const optionsStore = writable(buildOptions(page.params.slug ?? ""));
  $effect(() => {
    optionsStore.set(buildOptions(slug));
  });

  const query = createQuery<SkillDetail>(optionsStore);

  // Local editor state, hydrated when query resolves.
  let manifest = $state("");
  let displayName = $state("");
  let description = $state("");
  let serverSha = $state<string | null>(null);
  let hydrated = $state(false);

  $effect(() => {
    const data = $query.data;
    if (data && !hydrated) {
      manifest = data.manifest ?? "";
      displayName = data.display_name ?? "";
      description = data.description ?? "";
      serverSha = data.sha256 ?? null;
      hydrated = true;
    }
  });

  // When the slug changes (navigate to another editor), re-hydrate.
  $effect(() => {
    void slug;
    hydrated = false;
  });

  const sourceType = $derived($query.data?.source_type?.trim() || null);
  const sourceLabel = $derived(
    sourceType?.toLowerCase().includes("mattpocock") ? "Matt Pocock" : sourceType,
  );
  const isManaged = $derived($query.data?.managed === true || sourceType !== null);

  // ---- Save ----
  const saveMutation = createMutation({
    mutationFn: () =>
      skillsApi.store({
        slug,
        manifest,
        display_name: displayName,
        description,
      }),
    onSuccess: (result) => {
      serverSha = result.sha256 ?? null;
      toast.success(
        result.status === "unchanged" ? "No changes to save" : `Skill ${result.status}`,
      );
      void qc.invalidateQueries({ queryKey: ["skills"] });
      void qc.invalidateQueries({ queryKey: ["skills", slug] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to save";
      toast.error(msg);
    },
  });

  // ---- Delete ----
  let deleteOpen = $state(false);
  const deleteMutation = createMutation({
    mutationFn: () => skillsApi.delete(slug),
    onSuccess: () => {
      toast.success(`Skill "${slug}" deleted`);
      void qc.invalidateQueries({ queryKey: ["skills"] });
      void goto(`${base}/skills`);
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to delete";
      toast.error(msg);
    },
  });

  // ---- Generate (AI) ----
  let generateOpen = $state(false);
  let generatePrompt = $state("");
  const generateMutation = createMutation({
    mutationFn: () => skillsApi.generate({ prompt: generatePrompt.trim(), slug_hint: slug }),
    onSuccess: (result) => {
      manifest = result.manifest ?? manifest;
      if (result.display_name && !displayName) displayName = result.display_name;
      if (result.description && !description) description = result.description;
      toast.success("Manifest generated");
      generateOpen = false;
      generatePrompt = "";
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to generate manifest";
      toast.error(msg);
    },
  });

  // ---- Assist (AI) ----
  let assistOpen = $state(false);
  let assistQuestion = $state("");
  let assistResult = $state<string | null>(null);
  const assistMutation = createMutation({
    mutationFn: () =>
      skillsApi.assist({
        mode: "edit",
        messages: [{ role: "user", content: assistQuestion.trim() }],
        skill: { slug, manifest, display_name: displayName, description },
      }),
    onSuccess: (result) => {
      const reply = result.assistant_message?.content ?? result.manifest ?? "(no reply)";
      assistResult = reply;
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to fetch assistant reply";
      toast.error(msg);
    },
  });

  function applyAssistManifest() {
    if (!$assistMutation.data) return;
    const m = $assistMutation.data.manifest;
    if (m) {
      manifest = m;
      toast.success("Manifest replaced from assistant");
      closeAssist();
    } else {
      toast.error("Assistant did not return a manifest");
    }
  }

  function closeAssist() {
    assistOpen = false;
    assistQuestion = "";
    assistResult = null;
  }
</script>

<PageHeader title={displayName || slug} subtitle={`Skill · ${slug}`}>
  {#snippet actions()}
    <Button variant="outline" href={`${base}/skills`}>
      <ArrowLeft class="h-4 w-4" />
      Back
    </Button>
  {/snippet}
</PageHeader>

{#if $query.isLoading}
  <p class="text-sm text-muted-foreground">Loading skill…</p>
{:else if $query.isError}
  <p class="text-sm text-destructive">
    {$query.error instanceof Error ? $query.error.message : "Failed to load skill"}
  </p>
{:else}
  <div class="flex flex-col gap-6">
    <!-- Editor -->
    <div class="flex flex-col gap-3">
      <span class="text-sm font-medium">Manifest (Markdown)</span>
      <Textarea
        aria-label="Skill manifest"
        class="min-h-[60vh] resize-y font-mono text-sm leading-relaxed"
        spellcheck="false"
        autocomplete="off"
        bind:value={manifest}
        readonly={isManaged}
      />
      <p class="text-xs text-muted-foreground">
        Manifest is the source of truth. Save updates the sha256 indicator.
      </p>
      <div class="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onclick={() => (generateOpen = true)}
          disabled={$generateMutation.isPending || isManaged}
        >
          <Sparkles class="h-4 w-4" />
          Generate (AI)
        </Button>
        <Button
          variant="outline"
          size="sm"
          onclick={() => (assistOpen = true)}
          disabled={$assistMutation.isPending || isManaged}
        >
          <Wand2 class="h-4 w-4" />
          Assist (AI)
        </Button>
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium">Rendered preview</span>
        <RenderedMarkdown source={manifest} />
      </div>
    </div>

    <aside aria-label="Skill controls" class="border-t pt-5">
      {#if isManaged}
        <div class="mb-3 rounded-md border border-warning/25 bg-warning-muted p-3 text-xs text-warning-muted-foreground">
          {#if sourceType}
            This skill is synchronized from
            {#if sourceType.toLowerCase().includes("mattpocock")}
              <a
                href={MATTPOCOCK_REPOSITORY}
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center gap-1 font-medium underline underline-offset-2"
              >
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
        </div>
      {/if}

      <Card.Root>
        <Card.Header class="flex-row items-center justify-between gap-2 space-y-0">
          <Card.Title class="text-sm">Metadata</Card.Title>
          <Badge variant={isManaged ? "secondary" : "success"}>
            {sourceLabel ?? (isManaged ? "managed" : "active")}
          </Badge>
        </Card.Header>
        <Card.Content class="space-y-3">
          <div class="space-y-1.5">
            <label for="meta-display-name" class="text-xs font-medium">Display name</label>
            <Input id="meta-display-name" bind:value={displayName} disabled={isManaged} />
          </div>
          <div class="space-y-1.5">
            <label for="meta-description" class="text-xs font-medium">Description</label>
            <Textarea
              id="meta-description"
              rows={3}
              bind:value={description}
              disabled={isManaged}
            />
          </div>
          {#if serverSha || $query.data?.uri || sourceType}
            <dl class="space-y-2 border-t pt-3 text-[11px]">
              {#if serverSha}
                <div>
                  <dt class="text-muted-foreground">sha256</dt>
                  <dd class="break-all font-mono" title={serverSha}>{serverSha.slice(0, 12)}…</dd>
                </div>
              {/if}
              {#if $query.data?.uri}
                <div>
                  <dt class="text-muted-foreground">URI</dt>
                  <dd class="break-all font-mono">{$query.data.uri}</dd>
                </div>
              {/if}
              {#if $query.data?.source_revision}
                <div>
                  <dt class="text-muted-foreground">Upstream revision</dt>
                  <dd class="break-all font-mono" title={$query.data.source_revision}>
                    {$query.data.source_revision.slice(0, 12)}…
                  </dd>
                </div>
              {/if}
              {#if $query.data?.source_path}
                <div>
                  <dt class="text-muted-foreground">Source path</dt>
                  <dd class="break-all font-mono">{$query.data.source_path}</dd>
                </div>
              {/if}
              {#if $query.data?.source_license}
                <div>
                  <dt class="text-muted-foreground">License</dt>
                  <dd>{$query.data.source_license}</dd>
                </div>
              {/if}
            </dl>
          {/if}
        </Card.Content>
      </Card.Root>

      <div class="mt-3 flex items-center justify-end gap-3 border-t px-1 pt-3">
        <Button onclick={() => $saveMutation.mutate()} disabled={$saveMutation.isPending || isManaged}>
          <Save class="h-4 w-4" />
          {$saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </aside>
  </div>

  <DangerZone description="Permanently soft-delete this skill. You can re-create it with the same slug later.">
    <Button
      variant="destructive"
      onclick={() => (deleteOpen = true)}
      disabled={$deleteMutation.isPending || isManaged}
    >
      <Trash2 class="h-4 w-4" />
      Delete skill
    </Button>
  </DangerZone>
{/if}

<!-- Generate dialog -->
<Dialog.Root bind:open={generateOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Generate manifest (AI)</Dialog.Title>
      <Dialog.Description>
        Describe what this skill should do. The runner will draft a full manifest and replace the
        editor contents.
      </Dialog.Description>
    </Dialog.Header>
    <Textarea
      class="min-h-[140px]"
      placeholder="e.g. coordinate multi-step refactors on PHP repositories…"
      bind:value={generatePrompt}
    />
    <Dialog.Footer class="flex justify-end gap-2">
      <Button variant="outline" onclick={() => (generateOpen = false)}>Cancel</Button>
      <Button
        disabled={$generateMutation.isPending || !generatePrompt.trim()}
        onclick={() => $generateMutation.mutate()}
      >
        {$generateMutation.isPending ? "Generating…" : "Generate"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Assist dialog -->
<Dialog.Root open={assistOpen} onOpenChange={(v) => (v ? (assistOpen = true) : closeAssist())}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Skill assistant</Dialog.Title>
      <Dialog.Description>
        Ask the assistant for suggestions about the current manifest. The reply appears below.
      </Dialog.Description>
    </Dialog.Header>
    <div class="space-y-3">
      <Textarea
        placeholder="e.g. tighten the When-to-use section…"
        bind:value={assistQuestion}
        rows={3}
      />
      <Button
        size="sm"
        disabled={$assistMutation.isPending || !assistQuestion.trim()}
        onclick={() => $assistMutation.mutate()}
      >
        {$assistMutation.isPending ? "Thinking…" : "Ask"}
      </Button>
      {#if assistResult}
        <div class="rounded-md border bg-muted/50 p-3">
          <h4 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Assistant reply
          </h4>
          <pre class="max-h-[40vh] overflow-y-auto whitespace-pre-wrap font-mono text-xs">{assistResult}</pre>
          {#if $assistMutation.data?.manifest}
            <div class="mt-2 flex justify-end">
              <Button size="sm" variant="outline" onclick={applyAssistManifest}>
                Apply manifest
              </Button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={closeAssist}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Delete confirm -->
<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete skill</Dialog.Title>
      <Dialog.Description>
        This will soft-delete <span class="font-mono">{slug}</span>. The action is reversible by
        re-creating the skill with the same slug.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="flex justify-end gap-2">
      <Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
      <Button
        variant="destructive"
        disabled={$deleteMutation.isPending}
        onclick={() => $deleteMutation.mutate()}
      >
        {$deleteMutation.isPending ? "Deleting…" : "Delete"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
