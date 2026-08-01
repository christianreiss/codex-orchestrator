<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils/cn";

  type Props = HTMLAttributes<HTMLDivElement> & {
    eyebrow?: string;
    title: string;
    subtitle?: string;
    headingLevel?: "h1" | "h2" | "h3";
    class?: string;
  };

  let {
    eyebrow,
    title,
    subtitle,
    headingLevel = "h2",
    class: className,
    ...rest
  }: Props = $props();
</script>

<div class={cn(className)} {...rest}>
  {#if eyebrow}<p class="eyebrow mb-1.5">{eyebrow}</p>{/if}
  {#if headingLevel === "h1"}
    <h1 class="font-display text-h1">{title}</h1>
  {:else if headingLevel === "h3"}
    <h3 class="font-display text-h3">{title}</h3>
  {:else}
    <h2 class="font-display text-h2">{title}</h2>
  {/if}
  {#if subtitle}<p class="mt-1.5 text-body-sm text-muted-foreground">{subtitle}</p>{/if}
</div>
