<script lang="ts">
  import type { HTMLThAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLThAttributes & { class?: string; children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<th
  class={cn(
    "h-11 bg-muted/45 px-4 text-left align-middle text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground [&:has([role=checkbox])]:pr-0",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</th>
