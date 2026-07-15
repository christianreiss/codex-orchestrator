<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = {
    title: string;
    subtitle?: string;
    headingLevel?: "h1" | "h2";
    class?: string;
    actions?: Snippet;
  };
  let { title, subtitle, headingLevel = "h1", class: className, actions }: Props = $props();
</script>

<header
  class={cn(
    "mb-7 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
    className,
  )}
>
  <div class="min-w-0 flex-1">
    {#if headingLevel === "h2"}
      <h2 class="text-[1.75rem] font-semibold leading-tight tracking-[-0.03em] md:text-[2rem]">
        {title}
      </h2>
    {:else}
      <h1 class="text-[1.75rem] font-semibold leading-tight tracking-[-0.03em] md:text-[2rem]">
        {title}
      </h1>
    {/if}
    {#if subtitle}
      <p class="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
      {@render actions()}
    </div>
  {/if}
</header>
