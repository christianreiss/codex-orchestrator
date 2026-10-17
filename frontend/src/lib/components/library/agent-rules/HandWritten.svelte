<script lang="ts">
  /**
   * The editing surface while the fleet is in hand-written mode: the whole
   * document is the textarea, served verbatim between the mandatory fleet
   * policy and the host capability guidance.
   */
  import { Textarea } from "$lib/components/ui/textarea";
  import { cn } from "$lib/utils/cn";
  import type { RulesDocState } from "./rules-doc.svelte";
  import type { RulesPreviewState } from "./rules-preview.svelte";

  let { doc, preview }: { doc: RulesDocState; preview: RulesPreviewState } = $props();
</script>

<!-- A hand-written document has no per-section attribution, so the whole
     editor links back to the one block it produced. -->
<div
  role="group"
  aria-label="Hand-written Markdown document"
  class={cn("space-y-2 rounded-md transition-colors", preview.linkClass("legacy_document"))}
  onmouseenter={() => preview.setActive({ kind: "legacy" })}
  onmouseleave={preview.clearActiveSetting}
  onfocusin={() => preview.setActive({ kind: "legacy" })}
  onfocusout={preview.clearActiveSetting}
>
  <div>
    <h2 class="text-h3">Hand-written Markdown</h2>
    <p class="text-body-sm text-muted-foreground">
      Served verbatim between the mandatory fleet policy and the host capability guidance, which are added either way. Saving stores a
      hand-written version; the module selection of the version before it stays in history.
    </p>
  </div>
  <Textarea
    id="agents-document"
    aria-label="Hand-written Markdown document"
    class="min-h-[60vh] resize-y font-mono text-body-sm leading-relaxed"
    spellcheck="false"
    autocomplete="off"
    bind:value={doc.content}
  />
</div>
