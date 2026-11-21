<script lang="ts">
  /**
   * Create or edit one project file. Saved by stored name (an existing name is
   * overwritten). The body is fetched on open: the file list stays lean.
   */
  import { onMount } from "svelte";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import SaveState from "$lib/components/page/SaveState.svelte";
  import Save from "@lucide/svelte/icons/save";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { ApiError } from "$lib/api/client";
  import { fetchFile, projectKeys, upsertFile } from "$lib/api/projects";
  import type { ProjectFileMetadata } from "$lib/api/types";

  type Props = { slug: string; file: ProjectFileMetadata | null; onDone: () => void; dirty?: boolean };
  let { slug, file, onDone, dirty = $bindable(false) }: Props = $props();

  const qc = useQueryClient();
  // svelte-ignore state_referenced_locally
  let storedName = $state(file?.stored_name ?? "");
  // svelte-ignore state_referenced_locally
  let mimeType = $state(file?.mime_type ?? "");
  // svelte-ignore state_referenced_locally
  let description = $state(file?.description ?? "");
  let content = $state("");
  // svelte-ignore state_referenced_locally
  let encoding = $state<"utf8" | "base64" | null>(file ? null : "utf8");
  // svelte-ignore state_referenced_locally
  let loadingBody = $state(file !== null);
  const isEditing = $derived(file !== null);

  let loadError = $state<string | null>(null);
  onMount(() => {
    if (!file) return;
    const id = file.id;
    let live = true;
    fetchFile(slug, id)
      .then(({ file: full }) => {
        if (!live) return;
        if (typeof full.content !== "string" || (full.content_encoding !== "utf8" && full.content_encoding !== "base64")) {
          loadError = "The server returned an unknown file encoding or missing contents";
          return;
        }
        encoding = full.content_encoding;
        content = full.content;
        baseline = JSON.stringify([file?.stored_name ?? "", file?.mime_type ?? "", file?.description ?? "", content]);
      })
      .catch((err) => { if (live) loadError = err instanceof ApiError ? err.message : "Could not load file contents"; })
      .finally(() => { if (live) loadingBody = false; });
    return () => { live = false; };
  });

  // The parent mounts one editor for each selected document.
  // svelte-ignore state_referenced_locally
  let baseline = $state(JSON.stringify([storedName, mimeType, description, content]));
  $effect(() => { dirty = JSON.stringify([storedName, mimeType, description, content]) !== baseline; });
  function cancel() { if (!dirty || window.confirm("Discard unsaved changes?")) onDone(); }

  const mutation = createMutation({
    mutationFn: () => {
      if (!encoding) throw new Error("File encoding is unavailable");
      return upsertFile(slug, { stored_name: storedName.trim(), mime_type: mimeType.trim() || null, description: description.trim() || null, content, encoding });
    },
    onSuccess: () => {
      baseline = JSON.stringify([storedName, mimeType, description, content]); dirty = false;
      toast.success("File saved");
      void qc.invalidateQueries({ queryKey: projectKeys.files(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save file"),
  });
  const canSubmit = $derived(encoding !== null && !loadingBody && !loadError && storedName.trim().length > 0 && (encoding === "base64" || content.length > 0));
</script>

<DraftGuard {dirty} preserveOnSamePath />
<form class="flex flex-col gap-3" onsubmit={(e) => { e.preventDefault(); if (canSubmit && !$mutation.isPending) $mutation.mutate(); }}>
  {#if loadError}<p role="alert" class="text-destructive">{loadError}. Close and reopen this file to retry; saving is disabled to protect its contents.</p>{/if}
  <p role="status" class={loadingBody ? "text-body-sm text-muted-foreground" : "sr-only"}>{loadingBody ? "Loading file contents…" : ""}</p>
  <SaveState pending={$mutation.isPending} error={$mutation.error} {dirty} />
  <fieldset disabled={$mutation.isPending} class="contents">
  <div class="grid gap-3 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="file-name">Stored name</Label>
      <Input id="file-name" bind:value={storedName} placeholder="docs/spec.md" disabled={isEditing} />
    </div>
    <div class="grid gap-1.5"><Label for="file-mime">MIME type</Label><Input id="file-mime" bind:value={mimeType} placeholder="text/markdown" /></div>
  </div>
  <div class="grid gap-1.5"><Label for="file-desc">Description</Label><Input id="file-desc" bind:value={description} placeholder="Optional description" /></div>
  <div class="grid gap-1.5">
    <Label for="file-content">{encoding === "base64" ? "Content (Base64)" : "Content"}</Label>
    <Textarea id="file-content" bind:value={content} rows={14} class="font-mono" disabled={loadingBody || !!loadError} placeholder={loadingBody ? "" : "File contents…"} />
  </div>
  <div class="flex justify-end gap-2 pt-2">
    <Button variant="ghost" type="button" onclick={cancel}>Cancel</Button>
    <Button type="submit" disabled={!canSubmit || loadingBody || $mutation.isPending}><Save class="h-4 w-4" />{$mutation.isPending ? "Saving…" : "Save file"}</Button>
  </div>
  </fieldset>
</form>
