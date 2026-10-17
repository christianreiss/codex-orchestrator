<script lang="ts">
  /**
   * Create or edit one project file. Saved by stored name (an existing name is
   * overwritten). The body is fetched on open: the file list stays lean.
   */
  import { onMount } from "svelte";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Save from "@lucide/svelte/icons/save";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { ApiError } from "$lib/api/client";
  import { fetchFile, projectKeys, upsertFile } from "$lib/api/projects";
  import type { ProjectFile } from "$lib/api/types";

  type Props = { slug: string; file: ProjectFile | null; onDone: () => void };
  let { slug, file, onDone }: Props = $props();

  const qc = useQueryClient();
  // svelte-ignore state_referenced_locally
  let storedName = $state(file?.stored_name ?? "");
  // svelte-ignore state_referenced_locally
  let mimeType = $state(file?.mime_type ?? "");
  // svelte-ignore state_referenced_locally
  let description = $state(file?.description ?? "");
  let content = $state("");
  // svelte-ignore state_referenced_locally
  let loadingBody = $state(file !== null);
  const isEditing = $derived(file !== null);

  onMount(() => {
    if (!file) return;
    const id = file.id;
    let live = true;
    fetchFile(slug, id)
      .then(({ file: full }) => { if (live) content = full.content ?? ""; })
      .catch((err) => { toast.error(err instanceof ApiError ? err.message : "Could not load file contents"); onDone(); })
      .finally(() => { if (live) loadingBody = false; });
    return () => { live = false; };
  });

  const mutation = createMutation({
    mutationFn: () => upsertFile(slug, { stored_name: storedName.trim(), mime_type: mimeType.trim() || null, description: description.trim() || null, content }),
    onSuccess: () => {
      toast.success("File saved");
      void qc.invalidateQueries({ queryKey: projectKeys.files(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save file"),
  });
  const canSubmit = $derived(storedName.trim().length > 0 && content.length > 0);
</script>

<form class="flex flex-col gap-3" onsubmit={(e) => { e.preventDefault(); $mutation.mutate(); }}>
  <div class="grid gap-3 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="file-name">Stored name</Label>
      <Input id="file-name" bind:value={storedName} placeholder="docs/spec.md" disabled={isEditing} />
    </div>
    <div class="grid gap-1.5"><Label for="file-mime">MIME type</Label><Input id="file-mime" bind:value={mimeType} placeholder="text/markdown" /></div>
  </div>
  <div class="grid gap-1.5"><Label for="file-desc">Description</Label><Input id="file-desc" bind:value={description} placeholder="Optional description" /></div>
  <div class="grid gap-1.5">
    <Label for="file-content">Content</Label>
    <Textarea id="file-content" bind:value={content} rows={14} class="font-mono" disabled={loadingBody} placeholder={loadingBody ? "Loading contents…" : "File contents…"} />
  </div>
  <div class="flex justify-end gap-2 pt-2">
    <Button variant="ghost" type="button" onclick={onDone}>Cancel</Button>
    <Button type="submit" disabled={!canSubmit || loadingBody || $mutation.isPending}><Save class="h-4 w-4" />{$mutation.isPending ? "Saving…" : "Save"}</Button>
  </div>
</form>
