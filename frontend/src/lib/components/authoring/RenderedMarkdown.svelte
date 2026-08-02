<script lang="ts">
  /**
   * Read-only rendered-HTML preview of a raw markdown source string.
   *
   * Unlike MdPreview (which composes discrete frontmatter + body fields into
   * the .md text that will be written to disk), this renders markdown that's
   * already a single opaque blob in the editor — e.g. a skill manifest — so
   * the useful "preview" is what it will look like, not what it will say.
   */
  import { marked } from "marked";
  import DOMPurify from "dompurify";

  type Props = {
    source: string;
    class?: string;
    ariaLabel?: string;
  };
  let { source, class: className = "", ariaLabel = "Rendered Markdown preview" }: Props = $props();

  // Strip a leading YAML frontmatter block before rendering — otherwise
  // `---` read as Markdown (not YAML) is Setext heading syntax and the
  // frontmatter renders as a giant, garbled <h2>.
  const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

  const body = $derived(source.replace(FRONTMATTER_RE, "").trim());

  const html = $derived.by(() => {
    const raw = marked.parse(body, { async: false, gfm: true, breaks: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  role="region"
  aria-label={ariaLabel}
  tabindex="0"
  class={`md-prose max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 ${className}`}
>
  {#if body}
    {@html html}
  {:else}
    <p class="text-xs text-muted-foreground">Nothing to preview yet.</p>
  {/if}
</div>
