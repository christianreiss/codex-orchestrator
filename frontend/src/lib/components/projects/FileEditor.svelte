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
  import { fetchFile, projectKeys, upsertFile, type FilePayload } from "$lib/api/projects";
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
    meta: { inlineError: true },
    mutationFn: (payload: FilePayload) => upsertFile(slug, payload),
    onSuccess: () => {
      baseline = JSON.stringify([storedName, mimeType, description, content]); dirty = false;
      toast.success("File saved");
      void qc.invalidateQueries({ queryKey: projectKeys.files(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
      onDone();
    },
  });
  const invalidField = $derived.by(() => {
    const { error, variables } = $mutation;
    if (!(error instanceof ApiError) || error.status !== 422 || !variables) return null;
    const body = error.body;
    if (!body || typeof body !== "object" || !("param" in body)) return null;
    if (body.param === "content" && content === variables.content) return "content";
    if (body.param === "stored_name" && !isEditing && storedName.trim() === variables.stored_name) return "stored_name";
    return null;
  });
  let saveActions: HTMLDivElement;
  $effect(() => {
    if ($mutation.isError) saveActions.scrollIntoView({ block: "nearest" });
  });
  const canSubmit = $derived(encoding !== null && !loadingBody && !loadError && storedName.trim().length > 0 && (encoding === "base64" || content.length > 0));
  function save(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit || !encoding || $mutation.isPending) return;
    $mutation.mutate({ stored_name: storedName.trim(), mime_type: mimeType.trim() || null, description: description.trim() || null, content, encoding });
  }
</script>

<DraftGuard {dirty} preserveOnSamePath />
<form class="flex flex-col gap-3" onsubmit={save}>
  {#if loadError}<p role="alert" class="text-destructive">{loadError}. Close and reopen this file to retry; saving is disabled to protect its contents.</p>{/if}
  <p role="status" class={loadingBody ? "text-body-sm text-muted-foreground" : "sr-only"}>{loadingBody ? "Loading file contents…" : ""}</p>
  <fieldset disabled={$mutation.isPending} class="contents">
  <div class="grid gap-3 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="file-name">Stored name</Label>
      <Input id="file-name" bind:value={storedName} placeholder="docs/spec.md" disabled={isEditing}
        aria-invalid={invalidField === "stored_name" || undefined} aria-describedby={invalidField === "stored_name" ? "file-save-feedback" : undefined} />
    </div>
    <div class="grid gap-1.5"><Label for="file-mime">MIME type</Label><Input id="file-mime" bind:value={mimeType} placeholder="text/markdown" /></div>
  </div>
  <div class="grid gap-1.5"><Label for="file-desc">Description</Label><Input id="file-desc" bind:value={description} placeholder="Optional description" /></div>
  <div class="grid gap-1.5">
    <Label for="file-content">{encoding === "base64" ? "Content (Base64)" : "Content"}</Label>
    <Textarea id="file-content" bind:value={content} rows={14} class="font-mono"
      aria-invalid={invalidField === "content" || undefined} aria-describedby={invalidField === "content" ? "file-save-feedback" : undefined}
      disabled={loadingBody || !!loadError} placeholder={loadingBody ? "" : "File contents…"} />
  </div>
  </fieldset>
  <div bind:this={saveActions} class="flex flex-col gap-3">
    <div id="file-save-feedback"><SaveState pending={$mutation.isPending} error={$mutation.error} {dirty} /></div>
    <div class="flex justify-end gap-2 pt-2">
      <Button variant="ghost" type="button" disabled={$mutation.isPending} onclick={cancel}>Cancel</Button>
      <Button type="submit" disabled={!canSubmit} aria-disabled={$mutation.isPending || undefined}><Save class="h-4 w-4" />{$mutation.isPending ? "Saving…" : "Save file"}</Button>
    </div>
  </div>
</form>
