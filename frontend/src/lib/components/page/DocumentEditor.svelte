<script lang="ts">
  /**
   * Title, body, optional live preview, a collapsed settings block, and a
   * danger zone last. Used wherever someone edits a named document.
   */
  import type { Snippet } from "svelte";
  import PageShell from "./PageShell.svelte";
  import Section from "./Section.svelte";
  import DraftGuard from "./DraftGuard.svelte";
  import SaveState from "./SaveState.svelte";

  type Props = {
    title: string;
    dirty?: boolean;
    pending?: boolean;
    error?: unknown;
    saved?: boolean;
    description?: string;
    backHref?: string;
    actions?: Snippet;
    /** The main editing surface. */
    body: Snippet;
    preview?: Snippet;
    /** Metadata and rarely changed options; rendered below the body. */
    settings?: Snippet;
    danger?: Snippet;
  };
  let { title, description, actions, body, preview, settings, danger, dirty = false, pending = false, error = null, saved = false }: Props = $props();
</script>

<DraftGuard {dirty} />
<PageShell {title} {description} {actions} width={preview ? "wide" : "default"}>
  <SaveState {dirty} {pending} {error} {saved} />
  <div class={preview ? "grid gap-4 lg:grid-cols-2" : ""}>
    <div class="min-w-0 space-y-4">{@render body()}</div>
    {#if preview}<div class="min-w-0">{@render preview()}</div>{/if}
  </div>
  {#if settings}
    <details class="group rounded-md border">
      <summary class="cursor-pointer select-none px-3 py-2 text-body font-medium">Document metadata and options</summary>
      <div class="space-y-3 border-t p-3">{@render settings()}</div>
    </details>
  {/if}
  {#if danger}<Section title="Danger zone" danger>{@render danger()}</Section>{/if}
</PageShell>
