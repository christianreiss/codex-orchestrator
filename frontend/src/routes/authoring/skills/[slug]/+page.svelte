<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { writable } from "svelte/store";
  import { toast } from "svelte-sonner";
  import { skillsApi } from "$lib/api/skills";
  import type { SkillDetail } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import * as Dialog from "$lib/components/ui/dialog";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Save from "@lucide/svelte/icons/save";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Wand2 from "@lucide/svelte/icons/wand-2";
  import Trash2 from "@lucide/svelte/icons/trash-2";

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

  const isManaged = $derived($query.data?.managed === true);

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
      void goto(`${base}/authoring`);
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
    <Button variant="outline" href={`${base}/authoring`}>
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
  <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
    <!-- Editor -->
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between text-sm">
        <span class="font-medium">Manifest (Markdown)</span>
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
        bind:value={manifest}
        readonly={isManaged}
      />
      <p class="text-xs text-muted-foreground">
        Manifest is the source of truth. Save updates the sha256 indicator.
      </p>
    </div>

    <!-- Side panel -->
    <aside class="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
      {#if isManaged}
        <div class="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          This skill is managed by the system and cannot be edited or deleted.
        </div>
      {/if}

      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Metadata</h3>
        <div class="space-y-3">
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
        </div>
      </div>

      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Actions</h3>
        <div class="flex flex-col gap-2">
          <Button onclick={() => $saveMutation.mutate()} disabled={$saveMutation.isPending || isManaged}>
            <Save class="h-4 w-4" />
            {$saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="outline"
            onclick={() => (generateOpen = true)}
            disabled={$generateMutation.isPending || isManaged}
          >
            <Sparkles class="h-4 w-4" />
            Generate (AI)
          </Button>
          <Button
            variant="outline"
            onclick={() => (assistOpen = true)}
            disabled={$assistMutation.isPending || isManaged}
          >
            <Wand2 class="h-4 w-4" />
            Assist (AI)
          </Button>
          <Button
            variant="destructive"
            onclick={() => (deleteOpen = true)}
            disabled={$deleteMutation.isPending || isManaged}
          >
            <Trash2 class="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <div class="rounded-lg border bg-card p-4 text-xs">
        <div class="flex items-center gap-2">
          <Badge variant={isManaged ? "secondary" : "success"}>
            {isManaged ? "managed" : "active"}
          </Badge>
        </div>
        {#if $query.data?.uri}
          <p class="mt-2 break-all font-mono text-[10px] text-muted-foreground">
            {$query.data.uri}
          </p>
        {/if}
      </div>
    </aside>
  </div>
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
