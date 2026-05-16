<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";

  type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    submitting?: boolean;
    username?: string;
    onConfirm: () => void | Promise<void>;
  };

  let { open, onOpenChange, submitting = false, username, onConfirm }: Props = $props();
</script>

<Dialog.Root open={open} onOpenChange={onOpenChange}>
  <Dialog.Content class="sm:max-w-[420px]">
    <Dialog.Header>
      <div class="flex items-start gap-3">
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
          aria-hidden="true"
        >
          <AlertTriangle class="h-5 w-5" />
        </div>
        <div>
          <Dialog.Title>Delete user</Dialog.Title>
          <Dialog.Description>
            {#if username}
              Permanently remove <span class="font-medium text-foreground">{username}</span>?
            {:else}
              Permanently remove this user?
            {/if}
            Their active sessions and password resets will also be revoked.
          </Dialog.Description>
        </div>
      </div>
    </Dialog.Header>

    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={() => onOpenChange(false)} disabled={submitting}>
        Cancel
      </Button>
      <Button type="button" variant="destructive" onclick={onConfirm} disabled={submitting}>
        {submitting ? "Deleting…" : "Delete user"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
