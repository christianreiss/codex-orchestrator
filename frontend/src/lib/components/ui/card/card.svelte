<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLAttributes<HTMLDivElement> & { class?: string; children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<div
  class={cn(
    "rounded-xl border border-border/75 bg-card text-card-foreground shadow-[0_1px_2px_rgba(15,23,42,0.035),0_10px_32px_rgba(15,23,42,0.035)]",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</div>
