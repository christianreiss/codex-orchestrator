<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import type { EngineSwitchConfirmCopy } from "./engine-switch-consequences";

  type Props = {
    open: boolean;
    copy: EngineSwitchConfirmCopy;
    busy?: boolean;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  };

  let { open, copy, busy = false, onConfirm, onCancel }: Props = $props();

  function handleOpenChange(next: boolean) {
    if (next) return;
    // Ignore dismiss attempts while the mutation is in flight: closing here
    // would leave the switch and the fleet disagreeing with no way to tell
    // which one won.
    if (busy) return;
    onCancel();
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-[560px]">
    <Dialog.Header>
      <div class="flex items-start gap-3">
        <div
          class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
            copy.destructive ? "bg-destructive/10 text-destructive" : "bg-warning-muted text-warning"
          }`}
          aria-hidden="true"
        >
          <AlertTriangle class="h-5 w-5" />
        </div>
        <div class="flex-1">
          <Dialog.Title>{copy.title}</Dialog.Title>
          <Dialog.Description>{copy.description}</Dialog.Description>
        </div>
      </div>
    </Dialog.Header>

    {#if copy.warning}
      <p
        role="alert"
        class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
      >
        {copy.warning}
      </p>
    {/if}

    <ul class="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
      {#each copy.consequences as consequence (consequence)}
        <li>{consequence}</li>
      {/each}
    </ul>

    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={onCancel} disabled={busy}>Cancel</Button>
      <Button
        type="button"
        variant={copy.destructive ? "destructive" : "default"}
        onclick={onConfirm}
        disabled={busy}
      >
        {busy ? "Applying…" : copy.confirmLabel}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
