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
  import { EmptyState } from "$lib/components/ui/empty-state";
  import MattPocockSkillsSource from "$lib/components/authoring/MattPocockSkillsSource.svelte";
  import * as Table from "$lib/components/ui/table";
  import * as Sheet from "$lib/components/ui/sheet";
  import * as Dialog from "$lib/components/ui/dialog";
  import SortableHead from "$lib/components/data-table/SortableHead.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Search from "@lucide/svelte/icons/search";
  import Layers from "@lucide/svelte/icons/layers";

  const qc = useQueryClient();

  const query = createQuery({
    queryKey: ["skills"],
    queryFn: () => skillsApi.list(),
  });

  const skills = $derived($query.data?.skills ?? []);

  function status(row: SkillRow): { label: string; variant: "success" | "destructive" | "secondary" | "warning" } {
    if (row.deleted_at) return { label: "deleted", variant: "destructive" };
    if (row.source_type?.trim()) {
      return {
        label: row.source_type.toLowerCase().includes("mattpocock") ? "Matt Pocock" : row.source_type,
        variant: "secondary",
      };
    }
    if (row.managed) return { label: "managed", variant: "secondary" };
    if (row.status && row.status !== "ok") return { label: row.status, variant: "warning" };
    return { label: "active", variant: "success" };
  }

  // ---- Search ----
  let search = $state("");
  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((row) =>
      [row.display_name, row.slug, row.description].some((v) => v?.toLowerCase().includes(q)),
    );
  });

  // ---- Sort ----
  type SortKey = "name" | "status" | "updated";
  let sortKey = $state<SortKey>("name");
  let sortDir = $state<"asc" | "desc">("asc");
  function onSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
  }
  const sorted = $derived.by(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = (a.display_name || a.slug).localeCompare(b.display_name || b.slug);
          break;
        case "status":
          cmp = status(a).label.localeCompare(status(b).label);
          break;
        case "updated":
          cmp = (a.updated_at ?? "").localeCompare(b.updated_at ?? "");
          break;
      }
      if (cmp === 0) cmp = a.slug.localeCompare(b.slug);
      return cmp * dir;
    });
  });

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
      void goto(`${base}/skills/${encodeURIComponent(data.slug ?? variables.slug)}`);
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

<MattPocockSkillsSource />

<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div class="relative w-full sm:max-w-sm">
    <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    <Input
      bind:value={search}
      placeholder="Search by name, slug, description..."
      class="pl-9"
      aria-label="Search skills"
    />
  </div>
  <div class="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
    <p class="mr-1 text-xs text-muted-foreground">
      {#if search.trim()}
        Showing {sorted.length} of {skills.length}
      {:else}
        {skills.length} {skills.length === 1 ? "skill" : "skills"}
      {/if}
    </p>
    <Button
      variant="outline"
      size="icon"
      aria-label="Refresh"
      onclick={() => void qc.invalidateQueries({ queryKey: ["skills"] })}
      disabled={$query.isFetching}
    >
      <RefreshCw class={$query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
    </Button>
    <Button size="sm" onclick={() => (createOpen = true)}>
      <Plus class="h-4 w-4" />
      New skill
    </Button>
  </div>
</div>

<div class="overflow-hidden rounded-md border border-border/75 bg-card">
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <SortableHead label="Name" active={sortKey === "name"} dir={sortDir} onclick={() => onSort("name")} />
        <Table.Head>Slug</Table.Head>
        <SortableHead label="Status" active={sortKey === "status"} dir={sortDir} onclick={() => onSort("status")} />
        <SortableHead
          label="Updated"
          active={sortKey === "updated"}
          dir={sortDir}
          onclick={() => onSort("updated")}
        />
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
          <Table.Cell colspan={5}>
            <EmptyState
              icon={Layers}
              size="sm"
              title="No skills yet"
              description="Skills give agents reusable step-by-step procedures they can invoke by name."
            >
              {#snippet action()}
                <Button size="sm" onclick={() => (createOpen = true)}>
                  <Plus class="h-4 w-4" />
                  New skill
                </Button>
              {/snippet}
            </EmptyState>
          </Table.Cell>
        </Table.Row>
      {:else if sorted.length === 0}
        <Table.Row>
          <Table.Cell colspan={5}>
            <EmptyState
              icon={Search}
              size="sm"
              title={`No skills match "${search.trim()}"`}
              description="Try a different search."
            >
              {#snippet action()}
                <Button size="sm" variant="outline" onclick={() => (search = "")}>Clear search</Button>
              {/snippet}
            </EmptyState>
          </Table.Cell>
        </Table.Row>
      {:else}
        {#each sorted as row (row.slug)}
          {@const s = status(row)}
          <Table.Row>
            <Table.Cell class="font-medium">
              <a
                href={`${base}/skills/${encodeURIComponent(row.slug)}`}
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
                  href={`${base}/skills/${encodeURIComponent(row.slug)}`}
                >
                  <ExternalLink class="h-4 w-4" />
                  Open
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete skill ${row.display_name || row.slug}`}
                  disabled={!!row.managed || !!row.source_type?.trim()}
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
