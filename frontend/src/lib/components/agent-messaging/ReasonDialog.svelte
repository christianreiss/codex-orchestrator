<script lang="ts">
  /** A small "type a reason / value, then confirm" dialog. Replaces window.prompt. */
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";

  type Props = {
    open: boolean;
    title: string;
    description?: string;
    label: string;
    value?: string;
    placeholder?: string;
    confirmLabel?: string;
    /** Block confirming an empty value (alias clearing allows it). */
    required?: boolean;
    busy?: boolean;
    error?: string | null;
    confirmDisabled?: boolean;
    onConfirm: (value: string) => void | Promise<void>;
    onClose: () => void;
  };
  let { open, onClose, title, description, label, value = $bindable(""), placeholder, confirmLabel = "Confirm", required = true, busy = false, error = null, confirmDisabled = false, onConfirm }: Props = $props();
  const canConfirm = $derived(!busy && !confirmDisabled && (!required || value.trim() !== ""));
</script>

<Dialog.Root {open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
  <Dialog.Content size="sm">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      {#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
    </Dialog.Header>
    <form
      class="space-y-4"
      onsubmit={(event) => {
        event.preventDefault();
        if (canConfirm) void onConfirm(value.trim());
      }}
    >
      <div class="space-y-1.5">
        <Label for="reason-dialog-input">{label}</Label>
        <Input id="reason-dialog-input" bind:value {placeholder} disabled={busy} />
      </div>
      {#if error}<p role="alert" class="text-body-sm text-destructive">{error}</p>{/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" disabled={busy} onclick={onClose}>Cancel</Button>
        <Button type="submit" disabled={!canConfirm}>{busy ? "Working…" : confirmLabel}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
