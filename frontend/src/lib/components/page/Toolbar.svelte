<script lang="ts">
  /** Search, filters, a result count and the one primary action. */
  import type { Snippet } from "svelte";
  import Search from "@lucide/svelte/icons/search";
  import { Input } from "$lib/components/ui/input";
  import { cn } from "$lib/utils/cn";

  type Props = {
    search?: string;
    searchPlaceholder?: string;
    /** "12 hosts", "3 of 12". Shown after the filters. */
    count?: string;
    filters?: Snippet;
    actions?: Snippet;
    class?: string;
  };
  let { search = $bindable(), searchPlaceholder = "Search", count, filters, actions, class: className }: Props = $props();
</script>

<div class={cn("flex flex-wrap items-center gap-2", className)} role="search">
  {#if search !== undefined}
    <div class="relative w-full min-w-[12rem] sm:w-64">
      <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input bind:value={search} placeholder={searchPlaceholder} aria-label={searchPlaceholder} class="pl-8" />
    </div>
  {/if}
  {@render filters?.()}
  {#if count}<span class="text-body-sm text-muted-foreground" aria-live="polite">{count}</span>{/if}
  <div class="ml-auto flex flex-wrap items-center gap-2">{@render actions?.()}</div>
</div>
