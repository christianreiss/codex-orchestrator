<script lang="ts">
  /** Edit a board card's title, detail, due date and dependencies. Never moves it or touches its claim. */
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import * as Sheet from "$lib/components/ui/sheet";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { ApiError } from "$lib/api/client";
  import { projectKeys, updateCard } from "$lib/api/projects";
  import type { BoardCard } from "$lib/api/types";

  type Props = { slug: string; card: BoardCard | null; onClose: () => void };
  let { slug, card, onClose }: Props = $props();

  const qc = useQueryClient();
  let title = $state("");
  let detail = $state("");
  let dueAt = $state("");
  let dependsOn = $state("");
  let error = $state<string | null>(null);

  // `datetime-local` wants a local wall-clock string with no zone.
  function toLocalInput(iso: string): string {
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }

  function parseDependsOn(text: string): number[] | null {
    const out: number[] = [];
    for (const part of text.split(/[\s,]+/).filter(Boolean)) {
      const n = Number(part.replace(/^#/, ""));
      if (!Number.isInteger(n) || n <= 0) return null;
      if (!out.includes(n)) out.push(n);
    }
    return out;
  }

  $effect(() => {
    if (!card) return;
    title = card.title;
    detail = card.detail ?? "";
    dueAt = card.due_at ? toLocalInput(card.due_at) : "";
    dependsOn = (card.depends_on ?? []).map((n) => `#${n}`).join(", ");
    error = null;
  });

  const mutation = createMutation({
    mutationFn: (vars: { card: BoardCard; title: string; detail: string; due_at: string | null; depends_on: number[] }) =>
      updateCard(slug, vars.card.id, { title: vars.title, detail: vars.detail, due_at: vars.due_at, depends_on: vars.depends_on }),
    // A cycle or an unknown card number is the operator's mistake to fix, so it belongs in the sheet, not in a toast that closes it.
    onError: (err) => { error = err instanceof ApiError ? err.message : "Could not update the card"; },
    onSuccess: () => { toast.success("Card updated"); onClose(); },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.board(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });

  function submit() {
    if (!card) return;
    const trimmed = title.trim();
    if (!trimmed) { error = "Title cannot be empty"; return; }
    const depends = parseDependsOn(dependsOn);
    if (depends === null) { error = "Depends on must be card numbers, like: #2, #3"; return; }
    error = null;
    $mutation.mutate({ card, title: trimmed, detail, due_at: dueAt ? new Date(dueAt).toISOString() : null, depends_on: depends });
  }
</script>

<Sheet.Root open={card !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
  <Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-lg">
    <Sheet.Header>
      <Sheet.Title>Edit card #{card?.number}</Sheet.Title>
      <Sheet.Description>Changes here do not move the card or touch its claim.</Sheet.Description>
    </Sheet.Header>
    <form class="mt-6 flex flex-col gap-3" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <div class="grid gap-1.5"><Label for="card-title">Title</Label><Input id="card-title" bind:value={title} /></div>
      <div class="grid gap-1.5"><Label for="card-detail">Detail</Label><Textarea id="card-detail" bind:value={detail} rows={6} /></div>
      <div class="grid gap-1.5"><Label for="card-due">Due</Label><Input id="card-due" type="datetime-local" bind:value={dueAt} /></div>
      <div class="grid gap-1.5">
        <Label for="card-deps">Depends on</Label>
        <Input id="card-deps" bind:value={dependsOn} placeholder="#2, #3" />
        <p class="text-caption text-muted-foreground">Card numbers this one waits on. Leave empty for none.</p>
      </div>
      {#if error}<Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>{/if}
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onclick={onClose}>Cancel</Button>
        <Button type="submit" disabled={$mutation.isPending}>{$mutation.isPending ? "Saving…" : "Save"}</Button>
      </div>
    </form>
  </Sheet.Content>
</Sheet.Root>
