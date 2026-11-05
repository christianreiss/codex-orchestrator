<script lang="ts">
  /** A client key is shown exactly once, here, right after it is minted. */
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { CopyButton } from "$lib/components/ui/copy-button";

  type Props = { reveal: { name: string; key: string; rotated: boolean } | null; onClose: () => void };
  let { reveal, onClose }: Props = $props();
</script>

<Dialog.Root open={reveal !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{reveal?.rotated ? "New key for" : "Key for"} {reveal?.name}</Dialog.Title>
      <Dialog.Description>
        Copy it now. The server keeps only a hash, so this key cannot be shown again{reveal?.rotated ? "; the previous key stopped working" : ""}. Hand it to the bot over a secret channel, never in a chat message.
      </Dialog.Description>
    </Dialog.Header>
    {#if reveal}
      <code class="block break-all rounded-md border bg-muted px-3 py-2 font-mono text-body-sm" data-testid="external-client-key">{reveal.key}</code>
    {/if}
    <Dialog.Footer>
      {#if reveal}<CopyButton value={reveal.key} label="Copy key" copiedLabel="Copied" toastMessage="Key copied" />{/if}
      <Button type="button" onclick={onClose}>I have stored it</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
