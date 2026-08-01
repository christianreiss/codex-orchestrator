<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Component, Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  import { emptyStateVariants, type EmptyStateSize } from "./index";

  type Props = HTMLAttributes<HTMLDivElement> & {
    icon?: Component;
    title: string;
    description?: string;
    action?: Snippet;
    size?: EmptyStateSize;
    class?: string;
  };

  let {
    icon: Icon,
    title,
    description,
    action,
    size = "default",
    class: className,
    ...rest
  }: Props = $props();

  const isSm = $derived(size === "sm");
</script>

<div class={cn(emptyStateVariants({ size }), className)} {...rest}>
  {#if Icon}
    <div
      class={cn(
        "flex items-center justify-center rounded-md bg-muted text-muted-foreground",
        isSm ? "h-9 w-9" : "h-14 w-14",
      )}
    >
      <Icon class={isSm ? "h-4 w-4" : "h-6 w-6"} />
    </div>
  {/if}
  <h3 class={cn("font-medium text-foreground", isSm ? "mt-2 text-sm" : "mt-4 text-sm")}>
    {title}
  </h3>
  {#if description}
    <p class={cn("max-w-sm text-muted-foreground", isSm ? "mt-0.5 text-xs" : "mt-1 text-sm")}>
      {description}
    </p>
  {/if}
  {#if action}
    <div class={isSm ? "mt-2" : "mt-4"}>
      {@render action()}
    </div>
  {/if}
</div>
