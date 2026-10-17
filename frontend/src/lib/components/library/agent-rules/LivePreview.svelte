<script lang="ts">
  /**
   * The live preview: the effective AGENTS.md as a host would receive it
   * (default), or only what this editor stores (canonical base). Updates as
   * any setting changes; hovering a block lights up the setting behind it.
   */
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { cn } from "$lib/utils/cn";
  import RenderedMarkdown from "$lib/components/authoring/RenderedMarkdown.svelte";
  import type { RulesDocState } from "./rules-doc.svelte";
  import type { RulesPreviewState } from "./rules-preview.svelte";

  let { doc, preview }: { doc: RulesDocState; preview: RulesPreviewState } = $props();

  const effective = $derived(preview.activePreviewMode === "effective");
  const tab = "h-8 rounded-md px-3 text-body-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50";
</script>

<section class="min-w-0 space-y-2" aria-label="Live preview">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="min-w-0">
      <h2 class="text-h3">
        {effective ? "Effective AGENTS.md" : doc.builderMode ? "Generated canonical base" : "Stored canonical base"}
      </h2>
      <p class="text-body-sm text-muted-foreground">
        {#if effective}
          Updates as you change any setting. Hover a setting to light up the text it produces.
        {:else}
          Only what this editor stores. The mandatory policy and host capabilities are added when served.
        {/if}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <div class="inline-flex rounded-md border p-0.5" role="group" aria-label="Preview scope">
        <button type="button" disabled={!preview.canRenderEffective} onclick={() => (preview.previewMode = "effective")} class={cn(tab, effective ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
          Effective document
        </button>
        <button type="button" onclick={() => (preview.previewMode = "canonical")} class={cn(tab, !effective ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
          Canonical base
        </button>
      </div>
      {#if effective}
        <CopyButton value={preview.previewContent} label="Copy document" copiedLabel="Copied" size="sm" />
      {:else}
        <CopyButton value={doc.canonicalDraft} label="Copy base" copiedLabel="Copied" size="sm" />
      {/if}
    </div>
  </div>

  {#if !preview.canRenderEffective}
    <p class="text-body-sm text-muted-foreground">
      No host is enrolled, so the host-specific feature block cannot be rendered. This shows the canonical base only; the security
      posture does not appear in it.
    </p>
  {:else if effective && preview.renderError}
    <p class="rounded-md border border-destructive/40 bg-destructive-muted px-3 py-2 text-body-sm text-destructive-muted-foreground">
      {preview.renderError} — showing the last document that rendered. Your edits are not lost; they are just not previewed.
    </p>
  {/if}

  <article aria-label={effective ? "Effective AGENTS.md preview document" : "Generated AGENTS.md base document"}>
    <RenderedMarkdown
      source={preview.previewContent}
      provenance={preview.previewProvenance}
      activeKeys={preview.activeKeys}
      onBlockHover={(key) => (preview.hoveredKey = key)}
      ariaLabel={effective ? "Effective AGENTS.md preview content" : "Generated AGENTS.md base content"}
      class="min-h-[65vh] bg-background p-6 sm:p-8"
    />
  </article>
</section>
