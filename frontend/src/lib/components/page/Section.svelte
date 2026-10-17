<script lang="ts">
  /** A titled block on the page surface. No card, no border: sections are separated by space and a heading. */
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = {
    title: string;
    description?: string;
    id?: string;
    /** Destructive blocks get a rule above them and sit last on the page. */
    danger?: boolean;
    actions?: Snippet;
    children?: Snippet;
    class?: string;
  };
  let { title, description, id, danger = false, actions, children, class: className }: Props = $props();
</script>

<section {id} class={cn("scroll-mt-20", danger && "border-t border-destructive/30 pt-4", className)}>
  <div class="mb-2 flex flex-wrap items-end justify-between gap-2">
    <div class="min-w-0">
      <h2 class={cn("text-h3", danger && "text-destructive")}>{title}</h2>
      {#if description}<p class="mt-0.5 text-body-sm text-muted-foreground">{description}</p>{/if}
    </div>
    {#if actions}<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>{/if}
  </div>
  {@render children?.()}
</section>
