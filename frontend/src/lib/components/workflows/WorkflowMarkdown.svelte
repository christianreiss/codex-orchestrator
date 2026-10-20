<script lang="ts">
  import { renderMarkdown } from "$lib/portal/markdown";
  import DOMPurify from "dompurify";
  let { text }: { text: string } = $props();
  const html = $derived(DOMPurify.sanitize(renderMarkdown(text), { ALLOWED_URI_REGEXP: /^(?:https?:|\/admin(?:\/|\?|$)|#)/i }).replace(/<h1(\s[^>]*)?>/gi, "<h3$1>").replace(/<\/h1>/gi, "</h3>"));
</script>
<div class="md-prose min-w-0 max-w-[65ch] break-words [overflow-wrap:anywhere]">{@html html}</div>
