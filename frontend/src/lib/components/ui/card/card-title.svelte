<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLAttributes<HTMLHeadingElement> & { class?: string; children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<h3 class={cn("text-lg font-semibold leading-none tracking-tight", className)} {...rest}>
  {@render children?.()}
</h3>
