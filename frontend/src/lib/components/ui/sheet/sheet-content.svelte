<script lang="ts">
  import { Dialog as SheetPrimitive } from "bits-ui";
  import X from "@lucide/svelte/icons/x";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  import Overlay from "./sheet-overlay.svelte";
  import { sheetVariants, type SheetSide } from "./index";

  type Props = SheetPrimitive.ContentProps & { side?: SheetSide; children?: Snippet };
  let { class: className, side = "right", children, ...rest }: Props = $props();
</script>

<SheetPrimitive.Portal>
  <Overlay />
  <SheetPrimitive.Content class={cn(sheetVariants({ side }), className)} {...rest}>
    {@render children?.()}
    <SheetPrimitive.Close
      class="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
    >
      <X class="h-4 w-4" />
      <span class="sr-only">Close</span>
    </SheetPrimitive.Close>
  </SheetPrimitive.Content>
</SheetPrimitive.Portal>
