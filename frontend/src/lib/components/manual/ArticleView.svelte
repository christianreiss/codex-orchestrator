<script lang="ts">
  import { Skeleton } from "$lib/components/ui/skeleton";
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

  // Re-fetch & re-render whenever slug changes.
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

  const articleTitle = $derived(meta.title ?? summary?.title ?? slug);
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

<div class="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_14rem]">
  <article class="min-w-0">
    {#if loading}
      <div class="space-y-4">
        <Skeleton class="h-9 w-2/3" />
        <Skeleton class="h-4 w-1/3" />
        <Skeleton class="h-32 w-full" />
        <Skeleton class="h-24 w-full" />
      </div>
    {:else if error}
      <div
        class="rounded-md border border-destructive/25 bg-destructive-muted p-4 text-sm text-destructive-muted-foreground"
      >
        <p class="font-medium">Could not load article</p>
        <p class="mt-1 opacity-80">{error}</p>
      </div>
    {:else}
      <header class="mb-6">
        <h1 class="text-3xl font-bold leading-tight tracking-tight text-foreground">
          {articleTitle}
        </h1>
        {#if summary?.summary}
          <p class="mt-2 text-base text-muted-foreground">{summary.summary}</p>
        {/if}
        <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {#if summary?.section}
            <span class="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground">
              {summary.section}
            </span>
          {/if}
          {#if meta.verified ?? summary?.verified}
            <span>Verified {meta.verified ?? summary?.verified}</span>
          {/if}
          {#each summary?.tags ?? [] as tag}
            <span class="rounded-md border border-border px-1.5 py-0.5">#{tag}</span>
          {/each}
        </div>
      </header>

      <div
        bind:this={contentRef}
        class="md-prose"
        use:copyCodeBlocks={html}
      >
        {@html html}
      </div>

      <footer class="mt-12 border-t border-border pt-4 text-xs italic text-muted-foreground">
        Edit on disk:
        <code class="not-italic rounded bg-muted px-1.5 py-0.5 text-foreground/80">
          {sourcePath}
        </code>
      </footer>
    {/if}
  </article>

  {#if !loading && !error && toc.length}
    <aside aria-label="Article contents" class="hidden lg:block">
      <div class="sticky top-6">
        <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          On this page
        </p>
        <nav aria-label="Table of contents">
          <ul class="space-y-1 border-l border-border">
            {#each toc as entry}
              <li>
                <a
                  href={`#${entry.id}`}
                  onclick={(e) => jumpTo(e, entry.id)}
                  class={
                    "block border-l-2 py-1 pl-3 text-sm transition-colors " +
                    (activeId === entry.id
                      ? "border-[hsl(var(--sidebar-active))] font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground") +
                    (entry.level === 3 ? " pl-6 text-xs" : "")
                  }
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
