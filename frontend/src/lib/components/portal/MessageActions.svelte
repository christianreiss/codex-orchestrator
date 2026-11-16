<script lang="ts">
  import type { Snippet } from "svelte";
  import * as Popover from "$lib/components/ui/popover";
  let { text, children }: { text: string; children?: Snippet } = $props();
  let status = $state("");
  async function copy() {
    try { await navigator.clipboard.writeText(text); status = "Copied full message"; }
    catch { status = "Could not copy. Expand the message and select its text to copy."; }
  }
</script>
<Popover.Root>
  <Popover.Trigger>
    {#snippet child({ props })}<button {...props} type="button" aria-label="Message actions" class="min-h-8 px-2 underline-offset-4 hover:underline pointer-coarse:min-h-11">More</button>{/snippet}
  </Popover.Trigger>
  <Popover.Content align="start" class="flex w-64 flex-wrap items-center gap-3 text-body-sm">
    <button type="button" class="min-h-8 underline-offset-4 hover:underline pointer-coarse:min-h-11" onclick={copy}>Copy full message</button>
    {@render children?.()}
    {#if status}<p role="status" class="w-full text-caption">{status}</p>{/if}
  </Popover.Content>
</Popover.Root>
