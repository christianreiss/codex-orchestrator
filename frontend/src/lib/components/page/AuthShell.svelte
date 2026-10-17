<script lang="ts">
  /** The frame for every signed-out or first-run screen: login, reset, CLI approval, setup. */
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = {
    title: string;
    description?: string;
    width?: "sm" | "lg";
    children?: Snippet;
    footer?: Snippet;
  };
  let { title, description, width = "sm", children, footer }: Props = $props();
</script>

<main class="flex min-h-screen items-center justify-center bg-background px-4 py-8">
  <div class={cn("w-full space-y-4", width === "sm" ? "max-w-sm" : "max-w-4xl")}>
    <div>
      <h1 class="text-xl font-semibold tracking-tight">{title}</h1>
      {#if description}<p class="mt-1 text-body-sm text-muted-foreground">{description}</p>{/if}
    </div>
    <div class="rounded-md border bg-card p-4">{@render children?.()}</div>
    {@render footer?.()}
  </div>
</main>
