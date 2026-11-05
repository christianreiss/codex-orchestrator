<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLAttributes<HTMLTableElement> & {
    class?: string;
    regionLabel?: string;
    /**
     * Bound the region's height from md up so it scrolls vertically itself and the
     * header stays in view. Sticky positioning attaches to this scroll region, so an
     * unbounded region never scrolls and its header scrolls away with the page.
     */
    stickyHeader?: boolean;
    children?: Snippet;
  };
  let { class: className, regionLabel = "Table", stickyHeader = false, children, ...rest }: Props = $props();
</script>

<!-- Scrollable region: keyboard users need focus to scroll it (axe scrollable-region-focusable). -->
<!-- scroll-padding keeps a focused row clear of the sticky header (WCAG 2.4.11). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class={cn("relative min-w-0 max-w-full w-full overflow-auto scroll-pt-10", stickyHeader && "md:max-h-[calc(100dvh-12rem)]")}
  tabindex="0"
  role="region"
  aria-label={regionLabel}
>
  <table class={cn("w-full caption-bottom text-body", className)} {...rest}>
    {@render children?.()}
  </table>
</div>
