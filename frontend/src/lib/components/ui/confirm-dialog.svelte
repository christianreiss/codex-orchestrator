<script lang="ts">
  import type { Snippet } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";

  type Props = {
    open: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    busyLabel?: string;
    destructive?: boolean;
    busy?: boolean;
    /** Keeps the confirm button disabled, e.g. while the target is being re-checked. */
    confirmDisabled?: boolean;
    /** When set, the operator must type this exact text (usually the entity name) before confirming. */
    requireText?: string | null;
    requireTextLabel?: string;
    /** Failure shown beside the task, not only in a toast. */
    error?: string | null;
    /** Details between the description and the buttons: what will happen, to which object. */
    children?: Snippet;
    onConfirm: () => void | Promise<void>;
    onClose?: () => void;
  };

  let {
    open = $bindable(),
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    busyLabel = "Working…",
    destructive = false,
    busy = false,
    confirmDisabled = false,
    requireText = null,
    requireTextLabel = "Type the name to confirm",
    error = null,
    children,
    onConfirm,
    onClose,
  }: Props = $props();

  const typedId = `confirm-text-${Math.random().toString(36).slice(2, 10)}`;
  let typed = $state("");
  const matches = $derived(!requireText || typed === requireText);

  $effect(() => {
    if (open) typed = "";
  });

  function handleOpenChange(next: boolean) {
    if (busy && !next) {
      // Ignore dismiss attempts (Escape, overlay click, X button) while a
      // mutation is in flight; re-assert open since bind:open may have
      // already propagated the close.
      open = true;
      return;
    }
    open = next;
    if (!next) onClose?.();
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      {#if description}
        <Dialog.Description>{description}</Dialog.Description>
      {/if}
    </Dialog.Header>
    {@render children?.()}
    {#if requireText}
      <div class="space-y-2">
        <Label for={typedId}>
          {requireTextLabel}: <span class="break-all font-mono font-semibold text-destructive">{requireText}</span>
        </Label>
        <Input
          id={typedId}
          bind:value={typed}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          disabled={busy}
        />
      </div>
    {/if}
    {#if error}
      <p class="text-body-sm text-destructive" role="alert">{error}</p>
    {/if}
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => handleOpenChange(false)}>
        {cancelLabel}
      </Button>
      <Button
        variant={destructive ? "destructive" : "default"}
        disabled={busy || confirmDisabled || !matches}
        onclick={async () => {
          if (!matches) return;
          await onConfirm();
        }}
      >
        {busy ? busyLabel : confirmLabel}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
