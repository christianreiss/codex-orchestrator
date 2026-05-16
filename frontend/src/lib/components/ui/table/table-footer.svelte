<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLAttributes<HTMLTableSectionElement> & { class?: string; children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<tfoot class={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)} {...rest}>
  {@render children?.()}
</tfoot>
