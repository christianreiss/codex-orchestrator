<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = {
    class?: string;
    children?: Snippet;
  };
  let { class: className, children }: Props = $props();
</script>

<div
  class={cn(
    "flex flex-col gap-3 rounded-md border border-border/70 bg-card/75 p-3 sm:flex-row sm:flex-wrap sm:items-center",
    className,
  )}>
  {@render children?.()}
</div>
