<script lang="ts">
  import MarkdownBody from "./MarkdownBody.svelte";
  let { text, markdown = true }: { text: string; markdown?: boolean } = $props();
</script>

<div class="message-content min-w-0 text-body-sm leading-relaxed [overflow-wrap:anywhere]">
  {#if markdown}<MarkdownBody {text} />{:else}<p class="whitespace-pre-wrap">{text}</p>{/if}
</div>

<style>
  .message-content :global(.md-prose-tight) { font-size: inherit; line-height: inherit; }
  .message-content :global(.md-prose-tight p),
  .message-content :global(.md-prose-tight ul),
  .message-content :global(.md-prose-tight ol) { margin-block: .75em; }
  .message-content :global(.md-prose-tight > :first-child) { margin-top: 0; }
  .message-content :global(.md-prose-tight > :last-child) { margin-bottom: 0; }
  .message-content :global(.md-prose-tight h1),
  .message-content :global(.md-prose-tight h2) { font-size: 1.15em; margin-block: 1.25em .5em; }
</style>
