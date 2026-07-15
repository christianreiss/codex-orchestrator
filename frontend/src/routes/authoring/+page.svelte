<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import { skillsApi } from "$lib/api/skills";
  import type { SkillRow } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { relativeTime } from "$lib/utils/format";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import * as Table from "$lib/components/ui/table";
  import * as Sheet from "$lib/components/ui/sheet";
  import * as Dialog from "$lib/components/ui/dialog";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";

  const qc = useQueryClient();

  const query = createQuery({
    queryKey: ["skills"],
    queryFn: () => skillsApi.list(),
  });

  const skills = $derived($query.data?.skills ?? []);
  const updatedAt = $derived(
    skills
      .map((s) => s.updated_at ?? null)
      .filter((v): v is string => !!v)
      .sort()
      .reverse()[0] ?? null,
  );

  function status(row: SkillRow): { label: string; variant: "success" | "destructive" | "secondary" | "warning" } {
    if (row.deleted_at) return { label: "deleted", variant: "destructive" };
    if (row.managed) return { label: "managed", variant: "secondary" };
    if (row.status && row.status !== "ok") return { label: row.status, variant: "warning" };
    return { label: "active", variant: "success" };
  }

  // ---- New skill sheet ----
  let createOpen = $state(false);
  let newSlug = $state("");
  let newName = $state("");
  let newDescription = $state("");

  type CreatePayload = { slug: string; display_name: string; description: string };

  const createSkill = createMutation({
    mutationFn: (payload: CreatePayload) =>
      skillsApi.store({
        slug: payload.slug,
        display_name: payload.display_name,
        description: payload.description,
        manifest: defaultManifest(payload),
      }),
    onSuccess: (data, variables: CreatePayload) => {
      toast.success(`Skill "${variables.slug}" created`);
      void qc.invalidateQueries({ queryKey: ["skills"] });
      createOpen = false;
      newSlug = "";
      newName = "";
      newDescription = "";
      void goto(`${base}/authoring/skills/${encodeURIComponent(data.slug ?? variables.slug)}`);
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to create skill";
      toast.error(msg);
    },
  });

  function defaultManifest({
    slug,
    display_name,
    description,
  }: {
    slug: string;
    display_name: string;
    description: string;
  }): string {
    const name = display_name || slug;
    const desc = description || "Describe when this skill should be invoked.";
    return `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n## When to use\n\n${desc}\n\n## Steps\n\n1. ...\n`;
  }

  function handleCreate() {
    const slug = newSlug.trim();
    if (!slug) {
      toast.error("Slug is required");
      return;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
      toast.error("Slug must be alphanumeric with . _ - separators");
      return;
    }
    $createSkill.mutate({
      slug,
      display_name: newName.trim() || slug,
      description: newDescription.trim(),
    });
  }

  // ---- Delete confirm ----
  let deleteTarget: SkillRow | null = $state(null);
  const deleteSkill = createMutation({
    mutationFn: (slug: string) => skillsApi.delete(slug),
    onSuccess: (_data: unknown, slug: string) => {
      toast.success(`Skill "${slug}" deleted`);
      void qc.invalidateQueries({ queryKey: ["skills"] });
      deleteTarget = null;
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to delete skill";
      toast.error(msg);
    },
  });
</script>

<section class="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-border/75 bg-card p-4 text-sm shadow-sm">
  <div class="flex flex-col">
    <span class="text-xs uppercase tracking-wide text-muted-foreground">Skills</span>
    <span class="text-lg font-semibold">{skills.length}</span>
  </div>
  <div class="flex flex-col">
    <span class="text-xs uppercase tracking-wide text-muted-foreground">Last updated</span>
    <span class="text-sm">{updatedAt ? relativeTime(updatedAt) : "—"}</span>
  </div>
  <div class="ml-auto flex items-center gap-2">
    <Button
      variant="outline"
      size="sm"
      onclick={() => void qc.invalidateQueries({ queryKey: ["skills"] })}
      disabled={$query.isFetching}
    >
      <RefreshCw class={$query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      Refresh
    </Button>
    <Button size="sm" onclick={() => (createOpen = true)}>
      <Plus class="h-4 w-4" />
      New skill
    </Button>
  </div>
</section>

<div class="overflow-hidden rounded-xl border border-border/75 bg-card shadow-sm">
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head>Name</Table.Head>
        <Table.Head>Slug</Table.Head>
        <Table.Head>Status</Table.Head>
        <Table.Head>Updated</Table.Head>
        <Table.Head class="text-right">Actions</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#if $query.isLoading}
        <Table.Row>
          <Table.Cell colspan={5} class="py-6 text-center text-sm text-muted-foreground">
            Loading skills…
          </Table.Cell>
        </Table.Row>
      {:else if $query.isError}
        <Table.Row>
          <Table.Cell colspan={5} class="py-6 text-center text-sm text-destructive">
            {$query.error instanceof Error ? $query.error.message : "Failed to load skills"}
          </Table.Cell>
        </Table.Row>
      {:else if skills.length === 0}
        <Table.Row>
          <Table.Cell colspan={5} class="py-6 text-center text-sm text-muted-foreground">
            No skills yet. Click "New skill" to author one.
          </Table.Cell>
        </Table.Row>
      {:else}
        {#each skills as row (row.slug)}
          {@const s = status(row)}
          <Table.Row>
            <Table.Cell class="font-medium">
              <a
                href={`${base}/authoring/skills/${encodeURIComponent(row.slug)}`}
                class="hover:underline"
              >
                {row.display_name || row.slug}
              </a>
              {#if row.description}
                <div class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{row.description}</div>
              {/if}
            </Table.Cell>
            <Table.Cell class="font-mono text-xs">{row.slug}</Table.Cell>
            <Table.Cell>
              <Badge variant={s.variant}>{s.label}</Badge>
            </Table.Cell>
            <Table.Cell class="text-sm text-muted-foreground">
              {row.updated_at ? relativeTime(row.updated_at) : "—"}
            </Table.Cell>
            <Table.Cell class="text-right">
              <div class="inline-flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  href={`${base}/authoring/skills/${encodeURIComponent(row.slug)}`}
                >
                  <ExternalLink class="h-4 w-4" />
                  Open
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete skill ${row.display_name || row.slug}`}
                  disabled={!!row.managed}
                  onclick={() => (deleteTarget = row)}
                >
                  <Trash2 class="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </Table.Cell>
          </Table.Row>
        {/each}
      {/if}
    </Table.Body>
  </Table.Root>
</div>

<!-- New skill sheet -->
<Sheet.Root bind:open={createOpen}>
  <Sheet.Content side="right" class="w-full sm:max-w-md">
    <Sheet.Header>
      <Sheet.Title>New skill</Sheet.Title>
      <Sheet.Description>
        Create an empty skill manifest. You'll be redirected to the editor on save.
      </Sheet.Description>
    </Sheet.Header>
    <div class="mt-6 space-y-4">
      <div class="space-y-1.5">
        <label for="new-skill-slug" class="text-sm font-medium">Slug</label>
        <Input
          id="new-skill-slug"
          placeholder="e.g. project-coordination"
          bind:value={newSlug}
          autocomplete="off"
        />
        <p class="text-xs text-muted-foreground">Lowercase, hyphens, periods or underscores.</p>
      </div>
      <div class="space-y-1.5">
        <label for="new-skill-name" class="text-sm font-medium">Display name</label>
        <Input id="new-skill-name" placeholder="Project coordination" bind:value={newName} />
      </div>
      <div class="space-y-1.5">
        <label for="new-skill-description" class="text-sm font-medium">Description</label>
        <Textarea
          id="new-skill-description"
          rows={4}
          placeholder="When this skill should be invoked…"
          bind:value={newDescription}
        />
      </div>
    </div>
    <Sheet.Footer class="mt-6 flex justify-end gap-2">
      <Button variant="outline" onclick={() => (createOpen = false)}>Cancel</Button>
      <Button onclick={handleCreate} disabled={$createSkill.isPending}>
        {$createSkill.isPending ? "Creating…" : "Create skill"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

<!-- Delete confirm dialog -->
<Dialog.Root open={!!deleteTarget} onOpenChange={(v) => (v ? null : (deleteTarget = null))}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete skill</Dialog.Title>
      <Dialog.Description>
        This will soft-delete <span class="font-mono">{deleteTarget?.slug}</span>. You can re-create
        it with the same slug later.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="flex justify-end gap-2">
      <Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
      <Button
        variant="destructive"
        disabled={$deleteSkill.isPending}
        onclick={() => deleteTarget && $deleteSkill.mutate(deleteTarget.slug)}
      >
        {$deleteSkill.isPending ? "Deleting…" : "Delete"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
