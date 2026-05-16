<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLAttributes<HTMLDivElement> & { class?: string; children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<div
  class={cn(
    "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</div>
