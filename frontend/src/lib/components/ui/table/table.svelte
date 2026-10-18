<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLAttributes<HTMLTableElement> & { class?: string; regionLabel?: string; children?: Snippet };
  let { class: className, regionLabel = "Table", children, ...rest }: Props = $props();
</script>

<!-- Scrollable region: keyboard users need focus to scroll it (axe scrollable-region-focusable). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="relative min-w-0 max-w-full w-full overflow-auto" tabindex="0" role="region" aria-label={regionLabel}>
  <table class={cn("w-full caption-bottom text-sm", className)} {...rest}>
    {@render children?.()}
  </table>
</div>
