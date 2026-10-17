<script lang="ts">
  /**
   * A sub-block inside an engine or fleet Section: optional small heading, helper
   * text, the controls, and the save indicator. No border and no card; the
   * enclosing `Section` provides the page-level heading.
   */
  import type { Snippet } from "svelte";
  import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";

  type Props = {
    id?: string;
    title?: string;
    description?: string;
    headerAction?: Snippet;
    children?: Snippet;
    /** Accepted for call-site compatibility; groups always render an h3. */
    headingLevel?: 2 | 3;
    status?: "idle" | "saving" | "saved" | "error";
    savedAt?: Date | string | null;
    error?: string | null;
  };
  let { id, title, description, headerAction, children, status = "idle", savedAt = null, error = null }: Props = $props();
</script>

<div {id} class="scroll-mt-20 py-2">
  {#if title || headerAction}
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        {#if title}<h3 class="text-body font-medium">{title}</h3>{/if}
        {#if description}<p class="mt-0.5 text-body-sm text-muted-foreground">{description}</p>{/if}
      </div>
      {#if headerAction}<div class="flex shrink-0 items-center gap-2">{@render headerAction()}</div>{/if}
    </div>
  {:else if description}
    <p class="text-body-sm text-muted-foreground">{description}</p>
  {/if}
  <div class="mt-2 space-y-3">{@render children?.()}</div>
  {#if status !== "idle" || savedAt || error}
    <div class="mt-2"><SaveIndicator {status} {savedAt} {error} /></div>
  {/if}
</div>
