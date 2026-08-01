<script lang="ts">
  import type { Snippet } from "svelte";
  import SaveIndicator from "./SaveIndicator.svelte";

  type Props = {
    id: string;
    title: string;
    description?: string;
    headerAction?: Snippet;
    children?: Snippet;
    headingLevel?: 2 | 3;
    /** "idle" | "saving" | "saved" | "error" */
    status?: "idle" | "saving" | "saved" | "error";
    savedAt?: Date | string | null;
    error?: string | null;
  };

  let {
    id,
    title,
    description,
    headerAction,
    children,
    headingLevel = 2,
    status = "idle",
    savedAt = null,
    error = null,
  }: Props = $props();
</script>

<section {id} class="scroll-mt-16 border-b border-border py-4">
    <div class="flex flex-row items-start justify-between gap-3">
      <div class="min-w-0">
        {#if headingLevel === 3}
          <h3 class="text-sm font-semibold">{title}</h3>
        {:else}
          <h2 class="text-sm font-semibold">{title}</h2>
        {/if}
        {#if description}
          <p class="mt-0.5 text-sm leading-normal text-muted-foreground">
            {description}
        </p>
        {/if}
      </div>
      {#if headerAction}
        <div class="flex shrink-0 items-center gap-2">{@render headerAction()}</div>
      {/if}
    </div>
    <div class="mt-3 space-y-3">
      {@render children?.()}
    </div>
    {#if status !== "idle" || savedAt || error}
      <div class="mt-3 flex items-center justify-between gap-2">
        <SaveIndicator {status} {savedAt} {error} />
      </div>
    {/if}
</section>
