<script lang="ts">
  import { StateBlock } from "$lib/components/page";
  import { fetchArticle } from "$lib/api/manual";
  import { renderMarkdown, type TocEntry } from "./markdown";
  import { copyCodeBlocks } from "./copyCodeBlocks";
  import type { ManualArticleSummary } from "$lib/api/types";

  type Props = {
    slug: string;
    summary?: ManualArticleSummary;
  };

  let { slug, summary }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let html = $state("");
  let toc = $state<TocEntry[]>([]);
  let meta = $state<Record<string, string>>({});
  let activeId = $state<string | null>(null);

  let contentRef: HTMLDivElement | null = $state(null);

  // Re-fetch and re-render whenever slug changes.
  $effect(() => {
    const currentSlug = slug;
    loading = true;
    error = null;
    html = "";
    toc = [];
    meta = {};
    activeId = null;

    void (async () => {
      try {
        const article = await fetchArticle(currentSlug);
        if (currentSlug !== slug) return; // stale
        meta = article.meta;
        const rendered = renderMarkdown(article.body);
        html = rendered.html;
        toc = rendered.toc;
      } catch (err) {
        if (currentSlug !== slug) return;
        error = err instanceof Error ? err.message : "Failed to load article";
      } finally {
        if (currentSlug === slug) loading = false;
      }
    })();
  });

  // After render, scroll to any hash anchor.
  $effect(() => {
    if (!html || !contentRef) return;
    queueMicrotask(() => {
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      if (hash) {
        const el = document.getElementById(hash);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        // Reset scroll on article switch.
        contentRef?.scrollTo?.({ top: 0 });
      }
    });
  });

  // Track which heading is in view to highlight the TOC.
  // Re-runs whenever the rendered article (html) or contentRef changes, so it
  // re-arms for each article without polling forever.
  $effect(() => {
    if (!html || !contentRef) return;
    let observer: IntersectionObserver | null = null;
    queueMicrotask(() => {
      if (!contentRef) return;
      const headings = contentRef.querySelectorAll<HTMLHeadingElement>("h2[id], h3[id]");
      if (!headings.length) return;
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              activeId = entry.target.id;
              break;
            }
          }
        },
        { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
      );
      headings.forEach((h) => observer!.observe(h));
    });
    return () => {
      observer?.disconnect();
    };
  });

  const sourcePath = $derived(`public/admin/manual/articles/${slug}.md`);

  function jumpTo(event: MouseEvent, id: string) {
    event.preventDefault();
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    if (typeof history !== "undefined") {
      history.replaceState(null, "", `#${id}`);
    }
    activeId = id;
  }
</script>

<div class="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_14rem]">
  <article class="min-w-0">
    {#if loading}
      <StateBlock state="loading" rows={5} />
    {:else if error}
      <StateBlock state="error" message={`Could not load article: ${error}`} />
    {:else}
      <div class="mb-4 flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground">
        {#if summary?.section}
          <span class="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground">{summary.section}</span>
        {/if}
        {#if meta.verified ?? summary?.verified}
          <span>Verified {meta.verified ?? summary?.verified}</span>
        {/if}
        {#each summary?.tags ?? [] as tag}
          <span class="rounded-md border border-border px-1.5 py-0.5">#{tag}</span>
        {/each}
      </div>

      <div bind:this={contentRef} class="md-prose" use:copyCodeBlocks={html}>
        {@html html}
      </div>

      <footer class="mt-10 border-t border-border pt-3 text-body-sm text-muted-foreground">
        Edit on disk:
        <code class="rounded-md bg-muted px-1.5 py-0.5 text-foreground/80">{sourcePath}</code>
      </footer>
    {/if}
  </article>

  {#if !loading && !error && toc.length}
    <aside aria-label="Article contents" class="hidden xl:block">
      <div class="sticky top-4">
        <p class="mb-2 text-caption uppercase tracking-wider text-muted-foreground">On this page</p>
        <nav aria-label="Table of contents">
          <ul class="space-y-0.5 border-l border-border">
            {#each toc as entry}
              <li>
                <a
                  href={`#${entry.id}`}
                  onclick={(e) => jumpTo(e, entry.id)}
                  class={"block border-l-2 py-1 pl-3 text-body-sm transition-colors " +
                    (activeId === entry.id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground") +
                    (entry.level === 3 ? " pl-6" : "")}
                >
                  {entry.text}
                </a>
              </li>
            {/each}
          </ul>
        </nav>
      </div>
    </aside>
  {/if}
</div>
