<script lang="ts">
  import { page } from "$app/state";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Save from "@lucide/svelte/icons/save";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import { ApiError } from "$lib/api/client";
  import {
    assistProject,
    projectKeys,
    updateAbout,
    updateRoster,
  } from "$lib/api/projects";
  import type { ProjectDetailResponse } from "$lib/api/types";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  // Subscribe to the parent layout's project-detail cache.
  let detail = $state<ProjectDetailResponse | undefined>(undefined);
  $effect(() => {
    detail = qc.getQueryData<ProjectDetailResponse>(projectKeys.detail(slug));
    const unsub = qc.getQueryCache().subscribe(() => {
      detail = qc.getQueryData<ProjectDetailResponse>(projectKeys.detail(slug));
    });
    return () => unsub();
  });

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

<div class="flex flex-col gap-6">
  <Card.Root>
    <Card.Header>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Card.Title>About</Card.Title>
          <Card.Description
            >Title, name, and a short description for this workspace.</Card.Description
          >
        </div>
        {#if aboutChanged}
          <Badge variant="warning">Unsaved changes</Badge>
        {/if}
      </div>
    </Card.Header>
    <Card.Content class="flex flex-col gap-3">
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
    </Card.Content>
    <Card.Footer class="flex flex-wrap justify-end gap-2 border-t pt-4">
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
    </Card.Footer>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Card.Title>Roster</Card.Title>
          <Card.Description>Markdown describing who is on this project.</Card.Description>
        </div>
        {#if rosterChanged}
          <Badge variant="warning">Unsaved changes</Badge>
        {/if}
      </div>
    </Card.Header>
    <Card.Content>
      <Textarea
        bind:value={roster}
        rows={12}
        class="font-mono text-sm"
        placeholder={"# Roster\n- @alice — owner\n- @bob — reviewer"}
      />
    </Card.Content>
    <Card.Footer class="flex flex-wrap justify-end gap-2 border-t pt-4">
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
    </Card.Footer>
  </Card.Root>
</div>
