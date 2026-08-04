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
  import { assignProvenance, type ProvenanceEntry } from "$lib/authoring/provenance";

  type Props = {
    source: string;
    class?: string;
    ariaLabel?: string;
    /**
     * Blocks of this document in document order. Omit it and the component
     * behaves exactly as it always has — the skills previews render the same
     * bytes through the same single sanitize call.
     */
    provenance?: ProvenanceEntry[];
    /** Keys whose blocks should read as highlighted. */
    activeKeys?: string[];
    /** Fires with the key of the block under the pointer, or null on leave. */
    onBlockHover?: (key: string | null) => void;
  };
  let {
    source,
    class: className = "",
    ariaLabel = "Rendered Markdown preview",
    provenance,
    activeKeys = [],
    onBlockHover,
  }: Props = $props();

  // Strip a leading YAML frontmatter block before rendering — otherwise
  // `---` read as Markdown (not YAML) is Setext heading syntax and the
  // frontmatter renders as a giant, garbled <h2>.
  const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

  const body = $derived(source.replace(FRONTMATTER_RE, "").trim());

  const html = $derived.by(() => {
    const raw = marked.parse(body, { async: false, gfm: true, breaks: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  });

  let container = $state<HTMLDivElement | null>(null);

  /**
   * Tag each rendered block with the setting that produced it.
   *
   * This runs *after* sanitizing rather than overriding marked's renderers, so
   * the emitted HTML is byte-identical for every caller that passes no
   * provenance, and nothing here depends on DOMPurify's attribute allowlist.
   *
   * Walking `children` means comment nodes — the `<!-- cxx:managed-* -->` block
   * markers — are skipped for free, and list items never surface at this level.
   */
  $effect(() => {
    const el = container;
    const entries = provenance;
    const active = new Set(activeKeys);
    // Read so the walk re-runs when the document is re-rendered: every settings
    // change replaces this HTML, and a highlight that survived only until the
    // next refetch would vanish mid-drag, exactly when it is being read.
    const rendered = html;
    if (!el || entries === undefined || rendered === "") return;

    const blocks = [...el.children] as HTMLElement[];
    const headings = blocks.filter((node) => node.tagName === "H2");
    const owners = assignProvenance(
      entries,
      headings.map((node) => node.textContent ?? ""),
    );
    const labels = new Map(entries.map((entry) => [entry.key, entry.label]));

    let current: string | null = null;
    let seen = 0;
    for (const node of blocks) {
      if (node.tagName === "H2") {
        current = owners[seen] ?? null;
        seen += 1;
      }
      // The `---` between two modules belongs to neither of them, and must not
      // end the run either: the next heading is what starts the next block.
      const key = node.tagName === "HR" ? null : current;
      if (key === null) {
        node.removeAttribute("data-provenance");
        node.removeAttribute("data-provenance-label");
        node.removeAttribute("data-provenance-active");
        continue;
      }
      node.setAttribute("data-provenance", key);
      node.setAttribute("data-provenance-label", labels.get(key) ?? key);
      if (active.has(key)) node.setAttribute("data-provenance-active", "true");
      else node.removeAttribute("data-provenance-active");
    }
  });

  /**
   * Pointer-only, and deliberately so: these listeners are attached here rather
   * than in the markup because the preview is a read-only document. Making its
   * blocks focusable to carry the reverse link would add a tab stop per section
   * to a region that is already one keyboard target, for information the
   * settings-to-text direction already conveys.
   */
  $effect(() => {
    const el = container;
    if (!el || !onBlockHover) return;
    const keyAt = (target: EventTarget | null): string | null =>
      target instanceof Element
        ? (target.closest("[data-provenance]")?.getAttribute("data-provenance") ?? null)
        : null;
    const onOver = (event: Event): void => onBlockHover(keyAt(event.target));
    const onOut = (): void => onBlockHover(null);
    el.addEventListener("mouseover", onOver);
    el.addEventListener("mouseleave", onOut);
    return () => {
      el.removeEventListener("mouseover", onOver);
      el.removeEventListener("mouseleave", onOut);
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={container}
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
