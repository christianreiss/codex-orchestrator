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
    "mb-5 flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between",
    className,
  )}
>
  <SectionHead {title} {subtitle} {eyebrow} {headingLevel} class="min-w-0 flex-1" />
  {#if actions}
    <div class="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
      {@render actions()}
    </div>
  {/if}
</header>
