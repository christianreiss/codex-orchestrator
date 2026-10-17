<script lang="ts">
  /** Collapsed "Advanced" disclosure inside an engine Section: the rarely-changed settings. */
  import type { Snippet } from "svelte";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";

  type Props = { id: string; open?: boolean; children?: Snippet };
  let { id, open = $bindable(false), children }: Props = $props();
</script>

<Collapsible.Root bind:open>
  <Collapsible.Trigger
    {id}
    class="group -ml-2 flex h-9 items-center gap-1.5 rounded-md px-2 text-body-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <ChevronRight class="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
    Advanced
    <span class="font-normal">native config, client settings, per-host exceptions</span>
  </Collapsible.Trigger>
  <Collapsible.Content class="space-y-2 pb-2">{@render children?.()}</Collapsible.Content>
</Collapsible.Root>
