<script lang="ts">
  import { base } from "$app/paths";
  import { createQuery } from "@tanstack/svelte-query";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import ArticleList from "$lib/components/manual/ArticleList.svelte";
  import SearchBox from "$lib/components/manual/SearchBox.svelte";
  import { filterArticles } from "$lib/components/manual/filter";
  import { fetchManifest, fetchSearchIndex } from "$lib/api/manual";
  import BookOpen from "@lucide/svelte/icons/book-open";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";

  const manifestQuery = createQuery({
    queryKey: ["manual", "manifest"],
    queryFn: fetchManifest,
    staleTime: 5 * 60_000,
  });

  const searchIndexQuery = createQuery({
    queryKey: ["manual", "search-index"],
    queryFn: fetchSearchIndex,
    staleTime: 5 * 60_000,
  });

  let query = $state("");
  let debouncedQuery = $state("");

  function onSearch(value: string) {
    debouncedQuery = value;
  }

  const articles = $derived($manifestQuery.data?.articles ?? []);
  const index = $derived($searchIndexQuery.data ?? null);
  const filtered = $derived(filterArticles(articles, debouncedQuery, index));

  // Featured: articles tagged "getting-started" if any, else the first
  // article in each of the first two sections.
  const featured = $derived.by(() => {
    if (!articles.length) return [];
    const starters = articles.filter((a) => (a.tags ?? []).includes("getting-started"));
    if (starters.length) return starters.slice(0, 4);
    const seen = new Set<string>();
    const picks: typeof articles = [];
    for (const a of articles) {
      if (seen.has(a.section)) continue;
      seen.add(a.section);
      picks.push(a);
      if (picks.length >= 4) break;
    }
    return picks;
  });
</script>

<PageHeader
  title="Manual"
  subtitle="Operator reference, generated from the codebase. {articles.length} articles."
/>

<div class="grid grid-cols-1 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
  <aside aria-label="Manual navigation" class="lg:sticky lg:top-6 lg:max-h-[calc(100vh-4rem)] lg:self-start lg:overflow-y-auto lg:pr-2">
    <div class="mb-4">
      <SearchBox bind:value={query} onInput={onSearch} />
      {#if debouncedQuery.trim()}
        <p class="mt-2 px-1 text-xs text-muted-foreground">
          {filtered.length} of {articles.length} match
        </p>
      {/if}
    </div>

    {#if $manifestQuery.isLoading}
      <div class="space-y-3">
        {#each Array(8) as _, i (i)}
          <Skeleton class="h-7 w-full" />
        {/each}
      </div>
    {:else if $manifestQuery.isError}
      <div class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
        Failed to load manifest:
        {$manifestQuery.error instanceof Error ? $manifestQuery.error.message : "unknown"}
      </div>
    {:else}
      <ArticleList articles={filtered} query={debouncedQuery} />
    {/if}
  </aside>

  <section class="min-w-0">
    <div class="rounded-xl border border-border bg-card p-6 shadow-sm md:p-8">
      <div class="flex items-start gap-4">
        <div class="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--sidebar-active))]/10 text-[hsl(var(--sidebar-active))] sm:flex">
          <BookOpen class="h-5 w-5" />
        </div>
        <div class="min-w-0">
          <h2 class="text-2xl font-semibold tracking-tight">Welcome to the manual</h2>
          <p class="mt-2 max-w-prose text-sm text-muted-foreground">
            Pick an article on the left, or jump straight into one of the featured pages below.
            Every article is generated from the live codebase &mdash; the &ldquo;Source references&rdquo;
            footer in each one points at the exact files it documents.
          </p>
        </div>
      </div>

      {#if $manifestQuery.isLoading}
        <div class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {#each Array(4) as _, i (i)}
            <Skeleton class="h-24 w-full" />
          {/each}
        </div>
      {:else if featured.length}
        <div class="mt-8">
          <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Featured articles
          </p>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {#each featured as article (article.slug)}
              <a
                href={`${base}/manual/${article.slug}`}
                class="group flex items-start justify-between gap-3 rounded-lg border border-border bg-background p-4 transition-colors hover:border-foreground/30 hover:bg-accent"
              >
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold text-foreground">{article.title}</p>
                  {#if article.section}
                    <p class="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                      {article.section}
                    </p>
                  {/if}
                  <p class="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
                    {article.summary}
                  </p>
                </div>
                <ArrowRight
                  class="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                />
              </a>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </section>
</div>
