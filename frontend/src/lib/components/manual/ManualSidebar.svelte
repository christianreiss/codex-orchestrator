<script lang="ts">
  /** Search plus the sectioned article list, shared by the manual index and every article. */
  import { base } from "$app/paths";
  import { createQuery } from "@tanstack/svelte-query";
  import { StateBlock } from "$lib/components/page";
  import ArticleList from "./ArticleList.svelte";
  import SearchBox from "./SearchBox.svelte";
  import { filterArticles } from "./filter";
  import { fetchManifest } from "$lib/api/manual";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";

  let { activeSlug }: { activeSlug?: string } = $props();

  const manifestQuery = createQuery({
    queryKey: ["manual", "manifest"],
    queryFn: fetchManifest,
    staleTime: 5 * 60_000,
  });

  let query = $state("");
  let debouncedQuery = $state("");

  const articles = $derived($manifestQuery.data?.articles ?? []);
  const filtered = $derived(filterArticles(articles, debouncedQuery));
</script>

<aside aria-label="Manual navigation" class="lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)] lg:self-start lg:overflow-y-auto lg:pr-2">
  {#if activeSlug}
    <a href={`${base}/manual`} class="mb-3 inline-flex items-center gap-1 text-body-sm font-medium text-muted-foreground hover:text-foreground">
      <ChevronLeft class="h-3.5 w-3.5" /> Manual home
    </a>
  {/if}
  <div class="mb-4">
    <SearchBox bind:value={query} onInput={(value) => (debouncedQuery = value)} />
    {#if debouncedQuery.trim()}
      <p class="mt-2 px-1 text-body-sm text-muted-foreground">{filtered.length} of {articles.length} match</p>
    {/if}
  </div>

  {#if $manifestQuery.isLoading}
    <StateBlock state="loading" rows={8} />
  {:else if $manifestQuery.isError}
    <StateBlock
      state="error"
      message={`Failed to load manifest: ${$manifestQuery.error instanceof Error ? $manifestQuery.error.message : "unknown"}`}
      onRetry={() => $manifestQuery.refetch()}
    />
  {:else}
    <ArticleList articles={filtered} {activeSlug} query={debouncedQuery} />
  {/if}
</aside>
