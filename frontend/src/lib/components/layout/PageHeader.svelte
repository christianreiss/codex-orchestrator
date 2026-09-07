<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  import SectionHead from "./SectionHead.svelte";

  type Props = {
    title: string;
    subtitle?: string;
    eyebrow?: string;
    headingLevel?: "h1" | "h2";
    class?: string;
    actions?: Snippet;
  };
  let { title, subtitle, eyebrow, headingLevel = "h1", class: className, actions }: Props = $props();
</script>

<header
  class={cn(
    "mb-6 flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-start lg:justify-between",
    className,
  )}
>
  <SectionHead {title} {subtitle} {eyebrow} {headingLevel} class="min-w-0 flex-1" />
  {#if actions}
    <div class="flex w-full shrink-0 flex-wrap items-center gap-2 lg:w-auto lg:justify-end">
      {@render actions()}
    </div>
  {/if}
</header>
