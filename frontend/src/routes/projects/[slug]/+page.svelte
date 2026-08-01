<script lang="ts">
  import { page } from "$app/state";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Save from "@lucide/svelte/icons/save";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Alert from "$lib/components/ui/alert";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import {
    assistProject,
    fetchProject,
    projectKeys,
    updateAbout,
    updateRoster,
  } from "$lib/api/projects";
  import type { ProjectDetailResponse } from "$lib/api/types";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  // Shares the parent layout's project-detail query cache (same key), so this
  // resolves to the already-fetched data without an extra request while still
  // exposing loading/error state so the form can't be edited from a blank baseline.
  const detailQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: projectKeys.detail(slug),
      queryFn: () => fetchProject(slug),
      enabled: slug.length > 0,
    })),
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

  function syncFromDetail(d: ProjectDetailResponse | undefined) {
    if (!d) return;
    const about = (d.project?.about ?? {}) as Record<string, unknown>;
    initialTitle = typeof about.title === "string" ? about.title : "";
    initialName = typeof about.name === "string" ? about.name : "";
    initialDesc = typeof about.description === "string" ? about.description : "";
    initialRoster = d.project?.roster_markdown ?? "";
    aboutTitle = initialTitle;
    aboutName = initialName;
    aboutDesc = initialDesc;
    roster = initialRoster;
  }
  $effect(() => {
    syncFromDetail(detail);
  });

  const aboutChanged = $derived(
    aboutTitle.trim() !== initialTitle.trim() ||
      aboutName.trim() !== initialName.trim() ||
      aboutDesc.trim() !== initialDesc.trim(),
  );
  const rosterChanged = $derived(roster !== initialRoster);

  const aboutMutation = createMutation({
    mutationFn: () =>
      updateAbout(slug, {
        title: aboutTitle.trim() || null,
        name: aboutName.trim() || null,
        description: aboutDesc.trim() || null,
      }),
    onSuccess: () => {
      toast.success("About saved");
      initialTitle = aboutTitle;
      initialName = aboutName;
      initialDesc = aboutDesc;
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.list });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not save about"),
  });

  const rosterMutation = createMutation({
    mutationFn: () => updateRoster(slug, roster),
    onSuccess: () => {
      toast.success("Roster saved");
      initialRoster = roster;
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not save roster"),
  });

  const assistMutation = createMutation({
    mutationFn: () => assistProject(slug),
    onSuccess: (data) => {
      toast.success(
        data.assistant_message ? `Assist: ${data.assistant_message}` : "Assist generated",
      );
      const about = (data.about ?? {}) as Record<string, unknown>;
      if (typeof about.title === "string") aboutTitle = about.title;
      if (typeof about.name === "string") aboutName = about.name;
      if (typeof about.description === "string") aboutDesc = about.description;
      if (typeof data.roster_markdown === "string") roster = data.roster_markdown;
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Assist failed"),
  });

  function resetAbout() {
    aboutTitle = initialTitle;
    aboutName = initialName;
    aboutDesc = initialDesc;
  }
  function resetRoster() {
    roster = initialRoster;
  }
</script>

{#if $detailQuery.isLoading}
  <div class="flex flex-col gap-6">
    <Skeleton class="h-48 w-full" />
    <Skeleton class="h-64 w-full" />
  </div>
{:else if $detailQuery.isError}
  <Alert.Root variant="destructive">
    <Alert.Title>Could not load project</Alert.Title>
    <Alert.Description>
      {$detailQuery.error instanceof ApiError ? $detailQuery.error.message : "Unknown error"}
    </Alert.Description>
  </Alert.Root>
{:else}
  <div class="divide-y divide-border border-y border-border">
    <section class="py-5">
      <header class="mb-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-sm font-semibold">About</h2>
            <p class="mt-1 text-sm text-muted-foreground">Title, name, and a short description for this workspace.</p>
          </div>
          {#if aboutChanged}
            <Badge variant="warning">Unsaved changes</Badge>
          {/if}
        </div>
      </header>
      <div class="flex flex-col gap-3">
        <div class="grid gap-1.5">
          <Label for="about-title">Title</Label>
          <Input id="about-title" bind:value={aboutTitle} placeholder={slug} />
        </div>
        <div class="grid gap-1.5">
          <Label for="about-name">Name</Label>
          <Input id="about-name" bind:value={aboutName} placeholder="Short name" />
        </div>
        <div class="grid gap-1.5">
          <Label for="about-desc">Description</Label>
          <Textarea
            id="about-desc"
            bind:value={aboutDesc}
            rows={4}
            placeholder="What is this workspace for?"
          />
        </div>
      </div>
      <footer class="mt-4 flex flex-wrap justify-end gap-2 border-t pt-3">
        <Button
          variant="outline"
          onclick={() => $assistMutation.mutate()}
          disabled={$assistMutation.isPending}
        >
          <Sparkles class="h-4 w-4" />
          {$assistMutation.isPending ? "Drafting…" : "AI-Assist"}
        </Button>
        <Button variant="ghost" onclick={resetAbout} disabled={!aboutChanged}>
          <RotateCcw class="h-4 w-4" />
          Reset
        </Button>
        <Button
          onclick={() => $aboutMutation.mutate()}
          disabled={!aboutChanged || $aboutMutation.isPending}
        >
          <Save class="h-4 w-4" />
          {$aboutMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </footer>
    </section>

    <section class="py-5">
      <header class="mb-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-sm font-semibold">Roster</h2>
            <p class="mt-1 text-sm text-muted-foreground">Markdown describing who is on this project.</p>
          </div>
          {#if rosterChanged}
            <Badge variant="warning">Unsaved changes</Badge>
          {/if}
        </div>
      </header>
      <div>
        <Textarea
          bind:value={roster}
          rows={12}
          class="font-mono text-sm"
          placeholder={"# Roster\n- @alice — owner\n- @bob — reviewer"}
        />
      </div>
      <footer class="mt-4 flex flex-wrap justify-end gap-2 border-t pt-3">
        <Button
          variant="outline"
          onclick={() => $assistMutation.mutate()}
          disabled={$assistMutation.isPending}
        >
          <Sparkles class="h-4 w-4" />
          Draft Roster
        </Button>
        <Button variant="ghost" onclick={resetRoster} disabled={!rosterChanged}>
          <RotateCcw class="h-4 w-4" />
          Reset
        </Button>
        <Button
          onclick={() => $rosterMutation.mutate()}
          disabled={!rosterChanged || $rosterMutation.isPending}
        >
          <Save class="h-4 w-4" />
          {$rosterMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </footer>
    </section>
  </div>
{/if}
