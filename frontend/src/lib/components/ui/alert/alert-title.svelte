<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLAttributes<HTMLHeadingElement> & { class?: string; children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<h5 class={cn("mb-1 font-medium leading-none tracking-tight", className)} {...rest}>
  {@render children?.()}
</h5>
