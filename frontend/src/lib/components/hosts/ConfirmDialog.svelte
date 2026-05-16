<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";

  type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    onConfirm: () => void | Promise<void>;
  };
  let {
    open = $bindable(false),
    onOpenChange,
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    destructive = false,
    onConfirm,
  }: Props = $props();

  let busy = $state(false);

  async function handleConfirm(): Promise<void> {
    busy = true;
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      busy = false;
    }
  }

  function handleOpenChange(value: boolean): void {
    open = value;
    onOpenChange(value);
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      {#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => handleOpenChange(false)} disabled={busy}
        >{cancelLabel}</Button
      >
      <Button
        variant={destructive ? "destructive" : "default"}
        disabled={busy}
        onclick={handleConfirm}>{busy ? "Working…" : confirmLabel}</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
