<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";

  type Props = {
    open: boolean;
    title?: string;
    description?: string;
    placeholder?: string;
    initialValue?: string;
    submitLabel?: string;
    submitting?: boolean;
    onSubmit: (name: string) => void | Promise<void>;
    onCancel?: () => void;
  };

  let {
    open = $bindable(false),
    title = "Name this passkey",
    description = "Give the new credential a recognizable label so you can find it later.",
    placeholder = "e.g. YubiKey 5C — work laptop",
    initialValue = "",
    submitLabel = "Save",
    submitting = false,
    onSubmit,
    onCancel,
  }: Props = $props();

  let value = $state("");
  let error = $state<string | null>(null);

  $effect(() => {
    // Reset when dialog opens (read initialValue lazily inside the effect).
    if (open) {
      value = initialValue;
      error = null;
    }
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      error = "Name is required";
      return;
    }
    if (trimmed.length > 255) {
      error = "Name must be 255 characters or fewer";
      return;
    }
    error = null;
    await onSubmit(trimmed);
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(o) => {
    if (!o && onCancel) onCancel();
  }}
>
  <Dialog.Content>
    <form onsubmit={submit} class="space-y-4">
      <Dialog.Header>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>{description}</Dialog.Description>
      </Dialog.Header>
      <div class="space-y-2">
        <Label for="passkey-name">Name</Label>
        <Input
          id="passkey-name"
          bind:value
          {placeholder}
          maxlength={255}
          autofocus
          aria-invalid={error ? "true" : undefined}
        />
        {#if error}
          <p class="text-xs text-destructive">{error}</p>
        {/if}
      </div>
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => {
            open = false;
            onCancel?.();
          }}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
