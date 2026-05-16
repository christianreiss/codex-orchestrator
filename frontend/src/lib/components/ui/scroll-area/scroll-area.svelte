<script lang="ts">
  import { ScrollArea as ScrollAreaPrimitive } from "bits-ui";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = ScrollAreaPrimitive.RootProps & { children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<ScrollAreaPrimitive.Root
  class={cn("relative overflow-hidden", className)}
  {...rest}
>
  <ScrollAreaPrimitive.Viewport class="h-full w-full rounded-[inherit]">
    {@render children?.()}
  </ScrollAreaPrimitive.Viewport>
  <ScrollAreaPrimitive.Scrollbar
    orientation="vertical"
    class="flex h-full w-2.5 touch-none select-none border-l border-l-transparent p-px transition-colors"
  >
    <ScrollAreaPrimitive.Thumb class="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.Scrollbar>
  <ScrollAreaPrimitive.Corner />
</ScrollAreaPrimitive.Root>
