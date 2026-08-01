<script lang="ts">
  import { Dialog as DialogPrimitive } from "bits-ui";
  import X from "@lucide/svelte/icons/x";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  import Overlay from "./dialog-overlay.svelte";

  type Props = DialogPrimitive.ContentProps & { children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<DialogPrimitive.Portal>
  <Overlay />
  <DialogPrimitive.Content
    class={cn(
      "fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-md border border-border/80 bg-background p-5 shadow-pop duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:p-6",
      className,
    )}
    {...rest}
  >
    {@render children?.()}
    <DialogPrimitive.Close
      class="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent"
    >
      <X class="h-4 w-4" />
      <span class="sr-only">Close</span>
    </DialogPrimitive.Close>
  </DialogPrimitive.Content>
</DialogPrimitive.Portal>
