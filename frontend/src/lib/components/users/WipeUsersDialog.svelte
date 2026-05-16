<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";

  type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    submitting?: boolean;
    onConfirm: () => void | Promise<void>;
  };

  let { open, onOpenChange, submitting = false, onConfirm }: Props = $props();

  let confirmText = $state("");
  const matches = $derived(confirmText === "WIPE");

  $effect(() => {
    if (open) confirmText = "";
  });

  async function handleConfirm() {
    if (!matches) return;
    await onConfirm();
  }
</script>

<Dialog.Root open={open} onOpenChange={onOpenChange}>
  <Dialog.Content class="sm:max-w-[440px]">
    <Dialog.Header>
      <div class="flex items-start gap-3">
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
          aria-hidden="true"
        >
          <AlertTriangle class="h-5 w-5" />
        </div>
        <div class="flex-1">
          <Dialog.Title>Wipe all users</Dialog.Title>
          <Dialog.Description>
            This permanently deletes every admin account, session, and password-reset record.
            It cannot be undone.
          </Dialog.Description>
        </div>
      </div>
    </Dialog.Header>

    <div class="space-y-2">
      <Label for="wipe-confirm">
        Type <span class="font-mono font-semibold text-destructive">WIPE</span> to confirm
      </Label>
      <Input
        id="wipe-confirm"
        bind:value={confirmText}
        placeholder="WIPE"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        disabled={submitting}
      />
    </div>

    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={() => onOpenChange(false)} disabled={submitting}>
        Cancel
      </Button>
      <Button
        type="button"
        variant="destructive"
        onclick={handleConfirm}
        disabled={!matches || submitting}
      >
        {submitting ? "Wiping…" : "Wipe everything"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
