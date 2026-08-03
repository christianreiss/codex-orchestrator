<script lang="ts">
  /**
   * Dialog chrome around the shared seeding panel.
   *
   * The form itself lives in `$lib/components/setup/SeedAuthPanel.svelte` so
   * this dialog and the first-run wizard cannot drift — between them they are
   * the only canonical-auth UI in the product.
   */
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import SeedAuthPanel from "$lib/components/setup/SeedAuthPanel.svelte";
  import type { AuthEngine } from "$lib/api/auth";

  type Props = {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Pre-select an engine (e.g. when a host advertises only one). */
    defaultEngine?: AuthEngine;
  };

  let {
    open = $bindable(false),
    onOpenChange,
    defaultEngine = "codex",
  }: Props = $props();

  function handleOpenChange(value: boolean): void {
    open = value;
    onOpenChange?.(value);
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header>
      <Dialog.Title>Seed auth</Dialog.Title>
      <Dialog.Description>
        Upload canonical credentials or mint a short-lived one-time seed command
        the operator runs on the host.
      </Dialog.Description>
    </Dialog.Header>

    <!--
      Keyed on `open` so each opening mounts a fresh panel. Calling the panel's
      `reset()` from an effect instead would depend on `bind:this` having landed
      before the effect runs, which is exactly the sort of ordering that works
      until it doesn't — and its failure mode is a previous operator's pasted
      credentials still sitting in the textarea.
    -->
    {#key open}
      <SeedAuthPanel
        {defaultEngine}
        onStored={(outcome) => {
          // Stay open on anything but a clean verification so the operator can
          // read what happened and correct it without reopening.
          if (outcome === "verified") handleOpenChange(false);
        }}
      >
        {#snippet footer({ busy, submit })}
          <Dialog.Footer>
            <Button variant="ghost" onclick={() => handleOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onclick={submit} disabled={busy}>
              {busy ? "Uploading…" : "Upload"}
            </Button>
          </Dialog.Footer>
        {/snippet}
      </SeedAuthPanel>
    {/key}
  </Dialog.Content>
</Dialog.Root>
