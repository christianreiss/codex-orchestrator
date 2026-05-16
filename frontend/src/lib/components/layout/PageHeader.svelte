<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = {
    title: string;
    subtitle?: string;
    class?: string;
    actions?: Snippet;
  };
  let { title, subtitle, class: className, actions }: Props = $props();
</script>

<header class={cn("mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
  <div class="min-w-0 flex-1">
    <h1 class="text-2xl font-bold leading-tight tracking-tight md:text-3xl">{title}</h1>
    {#if subtitle}
      <p class="mt-1 text-sm text-muted-foreground">{subtitle}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex flex-wrap items-center gap-2 sm:flex-nowrap">
      {@render actions()}
    </div>
  {/if}
</header>
