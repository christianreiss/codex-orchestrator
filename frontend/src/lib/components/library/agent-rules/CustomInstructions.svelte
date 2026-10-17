<script lang="ts">
  /** Free text appended to the generated document, linked to its block in the preview. */
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { cn } from "$lib/utils/cn";
  import type { RulesDocState } from "./rules-doc.svelte";
  import type { RulesPreviewState } from "./rules-preview.svelte";

  let { doc, preview }: { doc: RulesDocState; preview: RulesPreviewState } = $props();
</script>

<div
  role="group"
  aria-label="Custom instructions"
  class={cn("-m-2 space-y-1.5 rounded-md p-2 transition-colors", preview.linkClass("custom_instructions"))}
  onmouseenter={() => preview.setActive({ kind: "custom" })}
  onmouseleave={preview.clearActiveSetting}
  onfocusin={() => preview.setActive({ kind: "custom" })}
  onfocusout={preview.clearActiveSetting}
>
  <Label for="agents-custom-instructions" class="text-h3">Custom instructions</Label>
  <Textarea
    id="agents-custom-instructions"
    class="min-h-40 resize-y font-mono text-body-sm leading-relaxed"
    placeholder="Repository-independent fleet instructions that are not covered by a module…"
    spellcheck="false"
    bind:value={doc.customInstructions}
  />
</div>
