<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
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

<Dialog.Root bind:open onOpenChange={setOpen}>
  <Dialog.Content class="sm:max-w-xl">
    <form class="space-y-4" onsubmit={submit}>
      <Dialog.Header>
        <Dialog.Title>Append to {memory?.title || memory?.id || "shared memory"}</Dialog.Title>
        <Dialog.Description>
          The append is serialized on the server. Existing content and labels remain unchanged.
        </Dialog.Description>
      </Dialog.Header>
      <div class="space-y-1.5">
        <Label for="append-memory-content">Content to append</Label>
        <Textarea id="append-memory-content" bind:value={content} rows={10} class="font-mono text-xs leading-5" placeholder="Additional durable context…" />
        <p class="text-right text-[11px] text-muted-foreground">{content.length.toLocaleString()} characters</p>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => setOpen(false)} disabled={$mutation.isPending}>Cancel</Button>
        <Button type="submit" disabled={$mutation.isPending || !content}>
          {$mutation.isPending ? "Appending…" : "Append content"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
