<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  import { badgeVariants, type BadgeVariant } from "./index";

  type Props = HTMLAttributes<HTMLSpanElement> & {
    class?: string;
    variant?: BadgeVariant;
    children?: Snippet;
  };
  let { class: className, variant = "default", children, ...rest }: Props = $props();
</script>

<span class={cn(badgeVariants({ variant }), className)} {...rest}>
  {@render children?.()}
</span>
