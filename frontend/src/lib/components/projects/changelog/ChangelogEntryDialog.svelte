<script lang="ts">
  /**
   * Create or edit one changelog entry as the operator. The operator may edit
   * every entry, including ones agents wrote; every save stays in Activity.
   */
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { toast } from "svelte-sonner";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { ApiError } from "$lib/api/client";
  import {
    CHANGELOG_KINDS,
    createChangelogEntry,
    projectKeys,
    updateChangelogEntry,
    type ChangelogEntry,
  } from "$lib/api/projects";
  import { filterClass } from "$lib/components/feedback/report-model";

  type Props = {
    open: boolean;
    slug: string;
    /** Edit this entry; null creates a new one. */
    entry: ChangelogEntry | null;
    /** Prefills the card for a new entry (card sheet). */
    cardId?: string | null;
  };
  let { open = $bindable(), slug, entry, cardId = null }: Props = $props();

  const qc = useQueryClient();
  let title = $state("");
  let kind = $state("change");
  let body = $state("");
  let tags = $state("");
  let card = $state("");
  let initial = $state("");
  let titleError = $state<string | null>(null);

  const snapshot = () => JSON.stringify([title, kind, body, tags, card]);
  const dirty = $derived(open && snapshot() !== initial);

  $effect(() => {
    if (!open) return;
    title = entry?.title ?? "";
    kind = entry?.kind ?? "change";
    body = entry?.body ?? "";
    tags = (entry?.tags ?? []).join(", ");
    card = entry?.card_id ?? cardId ?? "";
    titleError = null;
    initial = snapshot();
  });

  function setOpen(next: boolean): void {
    if (!next && ($mutation.isPending || (dirty && !window.confirm("Discard changes to this changelog entry?")))) {
      open = true;
      return;
    }
    open = next;
  }

  const mutation = createMutation({
    mutationFn: () => {
      const payload = {
        title: title.trim(),
        kind,
        body,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        card_id: card.trim() || null,
      };
      return entry ? updateChangelogEntry(slug, entry.id, payload) : createChangelogEntry(slug, payload);
    },
    onSuccess: () => {
      toast.success(entry ? "Changelog entry updated" : "Changelog entry added");
      void qc.invalidateQueries({ queryKey: ["project", slug, "changelog"] });
      void qc.invalidateQueries({ queryKey: ["projects", "changelog"] });
      void qc.invalidateQueries({ queryKey: projectKeys.changes(slug) });
      initial = snapshot();
      open = false;
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save the changelog entry"),
  });

  function submit(event: Event) {
    event.preventDefault();
    titleError = title.trim() ? null : "Title is required";
    if (titleError) return;
    $mutation.mutate();
  }
</script>

<DraftGuard {dirty} />
<Dialog.Root bind:open={() => open, setOpen}>
  <Dialog.Content class="sm:max-w-lg">
    <form onsubmit={submit} class="flex flex-col gap-4">
      <Dialog.Header>
        <Dialog.Title>{entry ? "Edit changelog entry" : "New changelog entry"}</Dialog.Title>
        <Dialog.Description>
          {entry ? `Entry #${entry.id} in ${slug}. The previous version stays in Activity.` : `Record what changed in ${slug} and why.`}
        </Dialog.Description>
      </Dialog.Header>
      <div class="grid gap-3">
        <div class="grid gap-1.5">
          <Label for="cl-title">Title <span class="text-destructive">*</span></Label>
          <Input id="cl-title" bind:value={title} maxlength={300} aria-invalid={!!titleError} aria-describedby={titleError ? "cl-title-error" : undefined} />
          {#if titleError}<p id="cl-title-error" class="text-body-sm text-destructive">{titleError}</p>{/if}
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="grid gap-1.5">
            <Label for="cl-kind">Kind</Label>
            <select id="cl-kind" class="{filterClass} w-full" bind:value={kind}>
              {#each CHANGELOG_KINDS as option (option)}<option value={option}>{option}</option>{/each}
            </select>
          </div>
          <div class="grid gap-1.5">
            <Label for="cl-card">Card id <span class="text-muted-foreground">(optional)</span></Label>
            <Input id="cl-card" bind:value={card} placeholder="Card UUID" class="font-mono" />
          </div>
        </div>
        <div class="grid gap-1.5">
          <Label for="cl-tags">Tags <span class="text-muted-foreground">(comma-separated)</span></Label>
          <Input id="cl-tags" bind:value={tags} />
        </div>
        <div class="grid gap-1.5">
          <Label for="cl-body">What changed and why</Label>
          <Textarea id="cl-body" bind:value={body} rows={8} class="font-mono text-body-sm" />
          <p class="text-caption text-muted-foreground">Markdown, up to 16 KiB.</p>
        </div>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => setOpen(false)}>Cancel</Button>
        <Button type="submit" disabled={$mutation.isPending}>{$mutation.isPending ? "Saving…" : entry ? "Save entry" : "Add entry"}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
