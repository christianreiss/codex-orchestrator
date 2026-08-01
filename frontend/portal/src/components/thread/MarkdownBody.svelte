<script lang="ts">
  import { renderMarkdown } from "../../lib/markdown";
  import { attachCopyButtons } from "../../lib/browser";

  let { text }: { text: string } = $props();

  const html = $derived(renderMarkdown(text));
  let node = $state<HTMLDivElement | null>(null);

  // Copy buttons are appended after render rather than templated in, because
  // the markdown arrives as a sanitized HTML string.
  $effect(() => {
    void html;
    if (node) attachCopyButtons(node);
  });
</script>

<div bind:this={node} class="md-prose md-prose-tight break-words">
  <!-- Sanitized by DOMPurify in lib/markdown.ts, which also strips every
       style attribute so the CSP is never tripped through innerHTML. -->
  {@html html}
</div>
