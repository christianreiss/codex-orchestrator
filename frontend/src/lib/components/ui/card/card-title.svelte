<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLAttributes<HTMLHeadingElement> & { class?: string; children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<h2 class={cn("text-lg font-semibold leading-tight tracking-[-0.02em]", className)} {...rest}>
  {@render children?.()}
</h2>
