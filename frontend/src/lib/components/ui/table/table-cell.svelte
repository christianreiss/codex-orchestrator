<script lang="ts">
  import type { HTMLTdAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLTdAttributes & { class?: string; children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<td class={cn("px-3 py-2 align-middle [&:has([role=checkbox])]:pr-0", className)} {...rest}>
  {@render children?.()}
</td>
