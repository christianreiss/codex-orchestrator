<script lang="ts">
  import MutationNotice from "$lib/components/feedback/MutationNotice.svelte";
  import { Dialog as DialogPrimitive } from "bits-ui";
  import X from "@lucide/svelte/icons/x";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  import Overlay from "./dialog-overlay.svelte";

  /**
   * Width stops (DESIGN.md geometry): sm 28rem confirmations and short input,
   * md 32rem ordinary forms (default), lg 36rem multi-field forms, xl 42rem
   * rich editors and pickers, wide 64rem previews and side-by-side content.
   * Callers choose a stop instead of an ad-hoc max-width.
   */
  type DialogSize = "sm" | "md" | "lg" | "xl" | "wide";
  const SIZES: Record<DialogSize, string> = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-xl", xl: "max-w-2xl", wide: "max-w-5xl" };
  type Props = DialogPrimitive.ContentProps & { children?: Snippet; size?: DialogSize };
  let { class: className, children, size = "md", ...rest }: Props = $props();
</script>

<DialogPrimitive.Portal>
  <Overlay />
  <DialogPrimitive.Content
    class={cn(
      "fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-lg border border-border/80 bg-background p-5 shadow-pop duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 sm:p-6",
      SIZES[size],
      className,
    )}
    {...rest}
  >
    <MutationNotice modal />
    {@render children?.()}
    <DialogPrimitive.Close
      class="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent"
    >
      <X class="h-4 w-4" />
      <span class="sr-only">Close</span>
    </DialogPrimitive.Close>
  </DialogPrimitive.Content>
</DialogPrimitive.Portal>
