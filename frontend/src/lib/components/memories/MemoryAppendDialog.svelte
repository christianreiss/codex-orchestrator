<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { toast } from "svelte-sonner";
  import { memoriesApi, memoriesKeys, type MemoryRecord } from "$lib/api/memories";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";

  type Props = {
    open: boolean;
    memory: MemoryRecord | null;
    onOpenChange: (open: boolean) => void;
    onAppended?: (memory: MemoryRecord) => void;
  };

  let { open = $bindable(), memory, onOpenChange, onAppended }: Props = $props();
  const qc = useQueryClient();
  let content = $state("");
  let wasOpen = false;

  function requestOpenChange(next: boolean): void {
    if (!next && ($mutation.isPending || (content.trim() && !window.confirm("Discard the unsaved append?")))) return;
    setOpen(next);
  }

  function setOpen(next: boolean): void {
    open = next;
    onOpenChange(next);
  }

  $effect(() => {
    if (open && !wasOpen) content = "";
    if (!open && wasOpen) content = "";
    wasOpen = open;
  });

  const mutation = createMutation({
    mutationFn: () => {
      if (!memory) throw new Error("No shared memory selected");
      if (!content) throw new Error("Append content is required");
      return memoriesApi.append(memory.record_id, content);
    },
    onSuccess: (result) => {
      toast.success("Content appended");
      void qc.invalidateQueries({ queryKey: memoriesKeys.all });
      qc.setQueryData(memoriesKeys.detail(result.memory.scope, result.memory.record_id), {
        status: "ok",
        memory: result.memory,
      });
      onAppended?.(result.memory);
      setOpen(false);
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not append content"),
  });

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    $mutation.mutate();
  }
</script>

<DraftGuard dirty={open && Boolean(content.trim())} />
<Dialog.Root bind:open={() => open, requestOpenChange}>
  <Dialog.Content size="lg">
    <form class="space-y-4" onsubmit={submit}>
      <Dialog.Header>
        <Dialog.Title>Append to {memory?.title || memory?.id || "shared memory"}</Dialog.Title>
        <Dialog.Description>
          The append is serialized on the server. Existing content and labels remain unchanged.
        </Dialog.Description>
      </Dialog.Header>
      <div class="space-y-1.5">
        <Label for="append-memory-content">Content to append</Label>
        <Textarea id="append-memory-content" disabled={$mutation.isPending} bind:value={content} rows={10} class="font-mono text-caption leading-5" placeholder="Additional durable context…" />
        <p class="text-right text-caption text-muted-foreground">{content.length.toLocaleString()} characters</p>
      </div>
      {#if $mutation.error}<p role="alert" class="text-body-sm text-destructive">{$mutation.error instanceof Error ? $mutation.error.message : "Could not confirm the append."} Your text is retained. If the response was lost, check the memory before appending again.</p>{/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => requestOpenChange(false)} disabled={$mutation.isPending}>Cancel</Button>
        <Button type="submit" disabled={$mutation.isPending || !content}>
          {$mutation.isPending ? "Appending…" : "Append content"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
