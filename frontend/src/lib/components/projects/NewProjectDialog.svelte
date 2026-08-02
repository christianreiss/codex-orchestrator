<script lang="ts">
  import { z } from "zod";
  import { toast } from "svelte-sonner";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { ApiError } from "$lib/api/client";
  import { createProject, projectKeys } from "$lib/api/projects";

  type Props = {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    /** When set, replaces the default post-create navigation to /projects/[slug]. */
    onCreated?: (slug: string) => void;
  };
  let { open = $bindable(), onOpenChange, onCreated }: Props = $props();

  const qc = useQueryClient();

  const slugSchema = z
    .string()
    .min(1, "Slug is required")
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Slug must be kebab-case (a–z, 0–9, hyphen).");

  let slug = $state("");
  let title = $state("");
  let name = $state("");
  let description = $state("");
  let roster = $state("");
  let slugError = $state<string | null>(null);

  $effect(() => {
    if (slug === "") {
      slugError = null;
      return;
    }
    const r = slugSchema.safeParse(slug);
    slugError = r.success ? null : r.error.issues[0]?.message ?? "Invalid slug";
  });

  function reset() {
    slug = "";
    title = "";
    name = "";
    description = "";
    roster = "";
    slugError = null;
  }

  function setOpen(next: boolean): void {
    open = next;
    onOpenChange?.(next);
  }

  const mutation = createMutation({
    mutationFn: async () => {
      const parsed = slugSchema.parse(slug);
      const aboutObj: Record<string, string> = {};
      if (title.trim()) aboutObj.title = title.trim();
      if (name.trim()) aboutObj.name = name.trim();
      if (description.trim()) aboutObj.description = description.trim();
      return createProject({
        slug: parsed,
        about: Object.keys(aboutObj).length ? aboutObj : null,
        roster_markdown: roster.trim() ? roster : undefined,
      });
    },
    onSuccess: (data) => {
      const createdSlug = data.project?.slug ?? slug;
      toast.success(`Project ${createdSlug} created`);
      void qc.invalidateQueries({ queryKey: projectKeys.list });
      setOpen(false);
      reset();
      if (onCreated) onCreated(createdSlug);
      else void goto(`${base}/projects/${encodeURIComponent(createdSlug)}`);
    },
    onError: (err) => {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error("Could not create project");
    },
  });

  function submit(event: Event) {
    event.preventDefault();
    if (!slug) {
      slugError = "Slug is required";
      return;
    }
    if (slugError) return;
    $mutation.mutate();
  }

  $effect(() => {
    if (!open) reset();
  });
</script>

<Dialog.Root bind:open onOpenChange={setOpen}>
  <Dialog.Content class="sm:max-w-lg">
    <form onsubmit={submit} class="flex flex-col gap-4">
      <Dialog.Header>
        <Dialog.Title>New project</Dialog.Title>
        <Dialog.Description>Create a coordination workspace.</Dialog.Description>
      </Dialog.Header>

      <div class="grid gap-3">
        <div class="grid gap-1.5">
          <Label for="np-slug">Slug <span class="text-destructive">*</span></Label>
          <Input
            id="np-slug"
            bind:value={slug}
            placeholder="my-workspace"
            autocomplete="off"
            spellcheck={false}
          />
          {#if slugError}
            <p class="text-xs text-destructive">{slugError}</p>
          {:else}
            <p class="text-xs text-muted-foreground">Lowercase letters, digits, hyphens.</p>
          {/if}
        </div>

        <div class="grid gap-1.5">
          <Label for="np-title">Title</Label>
          <Input id="np-title" bind:value={title} placeholder="Display title" />
        </div>

        <div class="grid gap-1.5">
          <Label for="np-name">Name</Label>
          <Input id="np-name" bind:value={name} placeholder="Short name" />
        </div>

        <div class="grid gap-1.5">
          <Label for="np-description">Description</Label>
          <Textarea
            id="np-description"
            bind:value={description}
            rows={3}
            placeholder="What is this workspace about?"
          />
        </div>

        <div class="grid gap-1.5">
          <Label for="np-roster">Roster (markdown)</Label>
          <Textarea
            id="np-roster"
            bind:value={roster}
            rows={4}
            placeholder="# Roster&#10;- @alice — owner"
          />
        </div>
      </div>

      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => setOpen(false)}
          disabled={$mutation.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={$mutation.isPending || !!slugError || !slug}>
          {$mutation.isPending ? "Creating…" : "Create project"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
