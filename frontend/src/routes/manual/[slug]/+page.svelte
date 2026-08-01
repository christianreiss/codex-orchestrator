<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { createQuery } from "@tanstack/svelte-query";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import ArticleList from "$lib/components/manual/ArticleList.svelte";
  import ArticleView from "$lib/components/manual/ArticleView.svelte";
  import SearchBox from "$lib/components/manual/SearchBox.svelte";
  import { filterArticles } from "$lib/components/manual/filter";
  import { fetchManifest } from "$lib/api/manual";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";

  const slug = $derived(page.params.slug ?? "");

  const manifestQuery = createQuery({
    queryKey: ["manual", "manifest"],
    queryFn: fetchManifest,
    staleTime: 5 * 60_000,
  });

  let query = $state("");
  let debouncedQuery = $state("");

  function onSearch(value: string) {
    debouncedQuery = value;
  }

  const articles = $derived($manifestQuery.data?.articles ?? []);
  const filtered = $derived(filterArticles(articles, debouncedQuery));
  const summary = $derived(articles.find((a) => a.slug === slug));
  const notFound = $derived(
    !$manifestQuery.isLoading && !!articles.length && !summary,
  );
</script>

<div class="grid grid-cols-1 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
  <aside aria-label="Manual navigation" class="lg:sticky lg:top-6 lg:max-h-[calc(100vh-4rem)] lg:self-start lg:overflow-y-auto lg:pr-2">
    <a
      href={`${base}/manual`}
      class="mb-3 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft class="h-3.5 w-3.5" />
      Manual home
    </a>
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
      <ArticleList articles={filtered} activeSlug={slug} query={debouncedQuery} />
    {/if}
  </aside>

  <section class="min-w-0">
    {#if notFound}
      <div class="rounded-md border border-warning/25 bg-warning-muted p-4 text-sm">
        <p class="font-semibold">Article not found</p>
        <p class="mt-1 text-muted-foreground">
          No article in the manifest matches the slug
          <code class="rounded bg-muted px-1.5 py-0.5">{slug}</code>.
        </p>
        <a
          href={`${base}/manual`}
          class="mt-3 inline-flex text-sm font-medium text-[hsl(var(--sidebar-active))] hover:underline"
        >
          Back to the manual
        </a>
      </div>
    {:else}
      <ArticleView {slug} {summary} />
    {/if}
  </section>
</div>
