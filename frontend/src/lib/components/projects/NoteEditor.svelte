<script lang="ts">
  /** Create or edit one project note: a header and a body, both required. */
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
  import { createNote, projectKeys, updateNote } from "$lib/api/projects";
  import type { ProjectNote } from "$lib/api/types";

  type Props = { slug: string; note: ProjectNote | null; onDone: () => void; dirty?: boolean };
  let { slug, note, onDone, dirty = $bindable(false) }: Props = $props();

  const qc = useQueryClient();
  // The editor is re-mounted per document, so the initial value is the whole story.
  // svelte-ignore state_referenced_locally
  let header = $state(note?.header ?? "");
  // svelte-ignore state_referenced_locally
  let body = $state(note?.body ?? "");

  // The parent mounts one editor for each selected document.
  // svelte-ignore state_referenced_locally
  let baseline = $state(JSON.stringify([header, body]));
  $effect(() => { dirty = JSON.stringify([header, body]) !== baseline; });
  function cancel() { if (!dirty || window.confirm("Discard unsaved changes?")) onDone(); }

  const mutation = createMutation({
    mutationFn: () => {
      const payload = { header: header.trim(), body: body.trim() };
      return note ? updateNote(slug, note.id, payload) : createNote(slug, payload);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save note"),
    onSuccess: () => { baseline = JSON.stringify([header, body]); dirty = false; toast.success(note ? "Note updated" : "Note saved"); onDone(); },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.notes(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });
  const canSubmit = $derived(header.trim().length > 0 && body.trim().length > 0);
</script>

<DraftGuard {dirty} />
<form class="flex flex-col gap-3" onsubmit={(e) => { e.preventDefault(); $mutation.mutate(); }}>
  <SaveState pending={$mutation.isPending} error={$mutation.error} {dirty} />
  <fieldset disabled={$mutation.isPending} class="contents">
  <div class="grid gap-1.5"><Label for="note-header">Header</Label><Input id="note-header" bind:value={header} placeholder="Short note title" /></div>
  <div class="grid gap-1.5"><Label for="note-body">Body</Label><Textarea id="note-body" bind:value={body} rows={12} placeholder="Note contents…" /></div>
  <div class="flex justify-end gap-2 pt-2">
    <Button variant="ghost" type="button" onclick={cancel}>Cancel</Button>
    <Button type="submit" disabled={!canSubmit || $mutation.isPending}><Save class="h-4 w-4" />{$mutation.isPending ? "Saving…" : "Save"}</Button>
  </div>
  </fieldset>
</form>
