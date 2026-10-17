<script lang="ts">
  /**
   * List on the page, detail in a side sheet. The standard shape for any
   * "browse, pick one, edit it" screen. The caller owns `open`; the detail is
   * only mounted while open.
   */
  import type { Snippet } from "svelte";
  import * as Sheet from "$lib/components/ui/sheet";

  type Props = {
    open: boolean;
    title: string;
    description?: string;
    list: Snippet;
    detail: Snippet;
    footer?: Snippet;
    onClose?: () => void;
  };
  let { open = $bindable(), title, description, list, detail, footer, onClose }: Props = $props();
</script>

{@render list()}
<Sheet.Root bind:open onOpenChange={(next) => { if (!next) onClose?.(); }}>
  <Sheet.Content side="right" class="flex w-full flex-col gap-4 sm:max-w-xl">
    <Sheet.Header>
      <Sheet.Title>{title}</Sheet.Title>
      {#if description}<Sheet.Description>{description}</Sheet.Description>{/if}
    </Sheet.Header>
    <div class="min-h-0 flex-1 overflow-y-auto">{@render detail()}</div>
    {#if footer}<Sheet.Footer>{@render footer()}</Sheet.Footer>{/if}
  </Sheet.Content>
</Sheet.Root>
