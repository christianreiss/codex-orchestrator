<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { FormField } from "$lib/components/ui/form-field";

  type Props = {
    open: boolean;
    title?: string;
    description?: string;
    placeholder?: string;
    initialValue?: string;
    /** Names the action and its object, e.g. "Save name". */
    submitLabel: string;
    submitting?: boolean;
    submitError?: string;
    onSubmit: (name: string) => void | Promise<void>;
    onCancel?: () => void;
  };

  let {
    open = $bindable(false),
    title = "Name this passkey",
    description = "Give the new credential a recognizable label so you can find it later.",
    placeholder = "e.g. YubiKey 5C — work laptop",
    initialValue = "",
    submitLabel,
    submitting = false,
    submitError = "",
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
      <FormField id="passkey-name" label="Name" error={error ?? undefined} class="space-y-2">
        {#snippet children(f)}
          <Input
            id="passkey-name"
            bind:value
            {placeholder}
            maxlength={255}
            autofocus
            aria-invalid={f.invalid}
            aria-describedby={f.describedBy}
          />
        {/snippet}
      </FormField>
      {#if submitError}<p role="alert" class="text-body-sm text-destructive">{submitError}</p>{/if}
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
