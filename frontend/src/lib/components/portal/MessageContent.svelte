<script module lang="ts">
  // Ephemeral view state, like chat drafts: survives switching conversations.
  const expandedMessages = new Set<string>();
</script>
<script lang="ts">
  import { tick, untrack } from "svelte";
  import MarkdownBody from "./MarkdownBody.svelte";
  let { text, messageKey, markdown = true, collapsible = true }: {
    text: string; messageKey: string; markdown?: boolean; collapsible?: boolean;
  } = $props();
  const contentId = $props.id();
  let expanded = $state(untrack(() => expandedMessages.has(messageKey)));
  let long = $state(false);
  let content = $state<HTMLDivElement>();
  const folded = $derived(collapsible && long && !expanded);
  $effect(() => {
    if (!content) return;
    const node = content;
    const measure = () => { long = node.scrollHeight > parseFloat(getComputedStyle(node).lineHeight) * 20 + 1; };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  });
  async function toggle() {
    expanded = !expanded;
    if (expanded) expandedMessages.add(messageKey);
    else expandedMessages.delete(messageKey);
    // Collapsing must not leave the focused control below the viewport.
    if (!expanded) {
      await tick();
      content?.closest("article")?.scrollIntoView({ block: "nearest" });
    }
  }
</script>

<div class="message-content min-w-0 text-body-sm leading-relaxed">
  <div id={contentId} class:folded>
    <!-- Folded previews are inert so clipped links/code controls cannot receive focus.
         Assistive technology gets a plain preview and the same expand control. -->
    <div bind:this={content} inert={folded} aria-hidden={folded ? true : undefined}>
      {#if markdown}<MarkdownBody {text} />{:else}<p class="whitespace-pre-wrap break-words">{text}</p>{/if}
    </div>
  </div>
  {#if folded}<p class="sr-only">Message preview: {text.slice(0, 800)}…</p>{/if}
  {#if collapsible && long}<button type="button" class="mt-2 min-h-8 font-medium text-primary underline-offset-4 hover:underline pointer-coarse:min-h-11"
      aria-expanded={expanded} aria-controls={contentId} onclick={toggle}>{expanded ? "Show less" : "Show full message"}</button>{/if}
</div>

<style>
  .folded { max-height: 20lh; overflow: hidden; }
  .message-content :global(.md-prose-tight) { font-size: inherit; line-height: inherit; }
  .message-content :global(.md-prose-tight p),
  .message-content :global(.md-prose-tight ul),
  .message-content :global(.md-prose-tight ol) { margin-block: .75em; }
  .message-content :global(.md-prose-tight > :first-child) { margin-top: 0; }
  .message-content :global(.md-prose-tight > :last-child) { margin-bottom: 0; }
  .message-content :global(.md-prose-tight h1),
  .message-content :global(.md-prose-tight h2) { font-size: 1.15em; margin-block: 1.25em .5em; }
</style>
