<script lang="ts">
  import { page } from "$app/state";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Save from "@lucide/svelte/icons/save";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import FileText from "@lucide/svelte/icons/file-text";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Upload from "@lucide/svelte/icons/upload";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Alert from "$lib/components/ui/alert";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import {
    deleteFile,
    fetchFiles,
    projectKeys,
    upsertFile,
  } from "$lib/api/projects";
  import { relativeTime, formatBytes } from "$lib/utils/format";
  import type { ProjectFile } from "$lib/api/types";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  const filesQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: projectKeys.files(slug),
      queryFn: () => fetchFiles(slug),
      enabled: slug.length > 0,
    })),
  );

  let storedName = $state("");
  let mimeType = $state("");
  let description = $state("");
  let content = $state("");

  function resetForm() {
    storedName = "";
    mimeType = "";
    description = "";
    content = "";
  }

  function loadInto(file: ProjectFile) {
    storedName = file.stored_name;
    mimeType = file.mime_type ?? "";
    description = file.description ?? "";
    content = file.content ?? "";
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const upsertMut = createMutation({
    mutationFn: () =>
      upsertFile(slug, {
        stored_name: storedName.trim(),
        mime_type: mimeType.trim() || null,
        description: description.trim() || null,
        content,
      }),
    onSuccess: () => {
      toast.success("File saved");
      void qc.invalidateQueries({ queryKey: projectKeys.files(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not save file"),
  });

  const deleteMut = createMutation({
    mutationFn: (id: number) => deleteFile(slug, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: projectKeys.files(slug) });
      const previous = qc.getQueryData(projectKeys.files(slug));
      qc.setQueryData<{ project: string; files: ProjectFile[] }>(
        projectKeys.files(slug),
        (prev) => ({
          project: prev?.project ?? slug,
          files: (prev?.files ?? []).filter((f) => f.id !== id),
        }),
      );
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(projectKeys.files(slug), ctx.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not delete file");
    },
    onSuccess: () => toast.success("File deleted"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.files(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });

  const files = $derived($filesQuery.data?.files ?? []);
  const canSubmit = $derived(storedName.trim().length > 0 && content.length > 0);
</script>

<div class="flex flex-col gap-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Upsert file</Card.Title>
      <Card.Description>
        Save by <span class="font-mono">stored_name</span>: existing entries are overwritten.
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-3">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for="file-name">Stored name</Label>
          <Input id="file-name" bind:value={storedName} placeholder="docs/spec.md" />
        </div>
        <div class="grid gap-1.5">
          <Label for="file-mime">MIME type</Label>
          <Input id="file-mime" bind:value={mimeType} placeholder="text/markdown" />
        </div>
      </div>
      <div class="grid gap-1.5">
        <Label for="file-desc">Description</Label>
        <Input id="file-desc" bind:value={description} placeholder="Optional description" />
      </div>
      <div class="grid gap-1.5">
        <Label for="file-content">Content</Label>
        <Textarea
          id="file-content"
          bind:value={content}
          rows={10}
          class="font-mono text-sm"
          placeholder="File contents…"
        />
      </div>
    </Card.Content>
    <Card.Footer class="flex flex-wrap justify-end gap-2 border-t pt-4">
      <Button variant="ghost" onclick={resetForm} disabled={!storedName && !content}>
        <RotateCcw class="h-4 w-4" />
        Reset
      </Button>
      <Button onclick={() => $upsertMut.mutate()} disabled={!canSubmit || $upsertMut.isPending}>
        <Save class="h-4 w-4" />
        {$upsertMut.isPending ? "Saving…" : "Save"}
      </Button>
    </Card.Footer>
  </Card.Root>

  <section class="flex flex-col gap-3">
    <h2 class="text-sm font-medium text-muted-foreground">
      {files.length} {files.length === 1 ? "file" : "files"}
    </h2>

    {#if $filesQuery.isLoading}
      <Skeleton class="h-20 w-full" />
    {:else if $filesQuery.isError}
      <Alert.Root variant="destructive">
        <Alert.Title>Could not load files</Alert.Title>
        <Alert.Description>
          {$filesQuery.error instanceof ApiError ? $filesQuery.error.message : "Unknown error"}
        </Alert.Description>
      </Alert.Root>
    {:else if files.length === 0}
      <div class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
        No files yet.
      </div>
    {:else}
      <div class="overflow-hidden rounded-lg border">
        <table class="w-full text-sm">
          <thead class="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th class="px-3 py-2">Name</th>
              <th class="px-3 py-2">MIME</th>
              <th class="hidden px-3 py-2 sm:table-cell">Description</th>
              <th class="hidden px-3 py-2 md:table-cell">Size</th>
              <th class="hidden px-3 py-2 lg:table-cell">Updated</th>
              <th class="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            {#each files as file (file.id)}
              <tr class="hover:bg-accent/30">
                <td class="px-3 py-2">
                  <div class="flex items-center gap-2">
                    <FileText class="h-4 w-4 text-muted-foreground" />
                    <span class="truncate font-mono text-xs">{file.stored_name}</span>
                  </div>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">{file.mime_type ?? "—"}</td>
                <td class="hidden truncate px-3 py-2 text-xs text-muted-foreground sm:table-cell"
                  >{file.description ?? "—"}</td
                >
                <td
                  class="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground md:table-cell"
                  >{formatBytes(file.size_bytes)}</td
                >
                <td
                  class="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell"
                  >{relativeTime(file.updated_at)}</td
                >
                <td class="px-3 py-2 text-right">
                  <div class="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onclick={() => loadInto(file)}>
                      <Upload class="h-4 w-4" />
                      Load
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete file ${file.stored_name}`}
                      onclick={() => $deleteMut.mutate(file.id)}
                      disabled={$deleteMut.isPending}
                    >
                      <Trash2 class="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>
