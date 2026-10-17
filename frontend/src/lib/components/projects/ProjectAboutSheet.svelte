<script lang="ts">
  /**
   * "About" for a project: title, name, description and the roster, edited in
   * place. AI-Assist drafts both from the project's content. The full project
   * is only fetched while the sheet is open.
   */
  import { untrack } from "svelte";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Save from "@lucide/svelte/icons/save";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import { Section, StateBlock } from "$lib/components/page";
  import { reactiveOptions } from "./reactive-options.svelte";
  import { ApiError } from "$lib/api/client";
  import { assistProject, fetchProject, projectKeys, updateAbout, updateRoster } from "$lib/api/projects";
  import type { ProjectDetailResponse } from "$lib/api/types";

  type Props = { slug: string; open: boolean };
  let { slug, open = $bindable() }: Props = $props();

  const qc = useQueryClient();
  const detailQuery = createQuery(
    reactiveOptions(() => ({ queryKey: projectKeys.detail(slug), queryFn: () => fetchProject(slug), enabled: open && slug.length > 0 })),
  );
  const detail = $derived<ProjectDetailResponse | undefined>($detailQuery.data);

  let aboutTitle = $state("");
  let aboutName = $state("");
  let aboutDesc = $state("");
  let roster = $state("");
  let initialTitle = $state("");
  let initialName = $state("");
  let initialDesc = $state("");
  let initialRoster = $state("");

  const aboutChanged = $derived(
    aboutTitle.trim() !== initialTitle.trim() || aboutName.trim() !== initialName.trim() || aboutDesc.trim() !== initialDesc.trim(),
  );
  const rosterChanged = $derived(roster !== initialRoster);

  // A refetch (another admin, an agent) refreshes the baseline but never overwrites unsaved edits.
  $effect(() => {
    const d = detail;
    if (!d) return;
    untrack(() => {
      const keepAbout = aboutChanged;
      const keepRoster = rosterChanged;
      const about = (d.project?.about ?? {}) as Record<string, unknown>;
      initialTitle = typeof about.title === "string" ? about.title : "";
      initialName = typeof about.name === "string" ? about.name : "";
      initialDesc = typeof about.description === "string" ? about.description : "";
      initialRoster = d.project?.roster_markdown ?? "";
      if (!keepAbout) resetAbout();
      if (!keepRoster) resetRoster();
    });
  });

  function resetAbout() { aboutTitle = initialTitle; aboutName = initialName; aboutDesc = initialDesc; }
  function resetRoster() { roster = initialRoster; }

  const saved = () => {
    void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    void qc.invalidateQueries({ queryKey: projectKeys.list });
  };

  const aboutMutation = createMutation({
    mutationFn: () => updateAbout(slug, { title: aboutTitle.trim() || null, name: aboutName.trim() || null, description: aboutDesc.trim() || null }),
    onSuccess: () => { toast.success("About saved"); initialTitle = aboutTitle; initialName = aboutName; initialDesc = aboutDesc; saved(); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save about"),
  });
  const rosterMutation = createMutation({
    mutationFn: () => updateRoster(slug, roster),
    onSuccess: () => { toast.success("Roster saved"); initialRoster = roster; saved(); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save roster"),
  });
  const assistMutation = createMutation({
    mutationFn: () => assistProject(slug),
    onSuccess: (data) => {
      toast.success(data.assistant_message ? `Assist: ${data.assistant_message}` : "Assist generated");
      const about = (data.about ?? {}) as Record<string, unknown>;
      if (typeof about.title === "string") aboutTitle = about.title;
      if (typeof about.name === "string") aboutName = about.name;
      if (typeof about.description === "string") aboutDesc = about.description;
      if (typeof data.roster_markdown === "string") roster = data.roster_markdown;
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Assist failed"),
  });
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-xl">
    <Sheet.Header>
      <Sheet.Title>Project details</Sheet.Title>
      <Sheet.Description>What this workspace is for and who is on it.</Sheet.Description>
    </Sheet.Header>

    <div class="mt-4 space-y-6">
      {#if $detailQuery.isError}
        <StateBlock state="error" message={$detailQuery.error instanceof ApiError ? $detailQuery.error.message : "Could not load project"} onRetry={() => void $detailQuery.refetch()} />
      {:else if !detail}
        <StateBlock state="loading" rows={5} />
      {:else}
        <Section title="About">
          {#snippet actions()}{#if aboutChanged}<Badge variant="warning">Unsaved changes</Badge>{/if}{/snippet}
          <div class="grid gap-3">
            <div class="grid gap-1.5"><Label for="about-title">Title</Label><Input id="about-title" bind:value={aboutTitle} placeholder={slug} /></div>
            <div class="grid gap-1.5"><Label for="about-name">Name</Label><Input id="about-name" bind:value={aboutName} placeholder="Short name" /></div>
            <div class="grid gap-1.5"><Label for="about-desc">Description</Label><Textarea id="about-desc" bind:value={aboutDesc} rows={4} placeholder="What is this workspace for?" /></div>
          </div>
          <div class="mt-3 flex flex-wrap justify-end gap-2">
            <Button variant="outline" onclick={() => $assistMutation.mutate()} disabled={$assistMutation.isPending}><Sparkles class="h-4 w-4" />{$assistMutation.isPending ? "Drafting…" : "AI-Assist"}</Button>
            <Button variant="ghost" onclick={resetAbout} disabled={!aboutChanged}><RotateCcw class="h-4 w-4" /> Reset</Button>
            <Button onclick={() => $aboutMutation.mutate()} disabled={!aboutChanged || $aboutMutation.isPending}><Save class="h-4 w-4" />{$aboutMutation.isPending ? "Saving…" : "Save"}</Button>
          </div>
        </Section>

        <Section title="Roster" description="Markdown describing who is on this project." class="border-t pt-4">
          {#snippet actions()}{#if rosterChanged}<Badge variant="warning">Unsaved changes</Badge>{/if}{/snippet}
          <Textarea bind:value={roster} rows={10} class="font-mono" aria-label="Roster" placeholder={"# Roster\n- @alice — owner\n- @bob — reviewer"} />
          <div class="mt-3 flex flex-wrap justify-end gap-2">
            <Button variant="outline" onclick={() => $assistMutation.mutate()} disabled={$assistMutation.isPending}><Sparkles class="h-4 w-4" /> Draft Roster</Button>
            <Button variant="ghost" onclick={resetRoster} disabled={!rosterChanged}><RotateCcw class="h-4 w-4" /> Reset</Button>
            <Button onclick={() => $rosterMutation.mutate()} disabled={!rosterChanged || $rosterMutation.isPending}><Save class="h-4 w-4" />{$rosterMutation.isPending ? "Saving…" : "Save"}</Button>
          </div>
        </Section>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
