<script lang="ts">
  /**
   * Thin convenience wrapper around the shadcn alert primitive: lays out an
   * optional icon, a title + description block, and an action slot.
   */
  import { Alert, AlertTitle, AlertDescription } from "$lib/components/ui/alert";
  import type { AlertVariant } from "$lib/components/ui/alert";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = {
    title: string;
    description?: string;
    variant?: AlertVariant;
    icon?: Snippet;
    actions?: Snippet;
    class?: string;
  };

  let { title, description, variant = "default", icon, actions, class: className }: Props = $props();
</script>

<Alert variant={variant} class={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}>
  <div class="flex items-start gap-3">
    {#if icon}
      <div class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
        {@render icon()}
      </div>
    {/if}
    <div class="min-w-0">
      <AlertTitle>{title}</AlertTitle>
      {#if description}
        <AlertDescription>{description}</AlertDescription>
      {/if}
    </div>
  </div>
  {#if actions}
    <div class="flex shrink-0 items-center gap-2">
      {@render actions()}
    </div>
  {/if}
</Alert>
