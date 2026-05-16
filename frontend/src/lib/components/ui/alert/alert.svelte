<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  import { alertVariants, type AlertVariant } from "./index";

  type Props = HTMLAttributes<HTMLDivElement> & {
    class?: string;
    variant?: AlertVariant;
    children?: Snippet;
  };
  let { class: className, variant = "default", children, ...rest }: Props = $props();
</script>

<div role="alert" class={cn(alertVariants({ variant }), className)} {...rest}>
  {@render children?.()}
</div>
