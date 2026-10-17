<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { createQuery } from "@tanstack/svelte-query";
  import { PageShell } from "$lib/components/page";
  import ManualSidebar from "$lib/components/manual/ManualSidebar.svelte";
  import ArticleView from "$lib/components/manual/ArticleView.svelte";
  import { fetchManifest } from "$lib/api/manual";

  const slug = $derived(page.params.slug ?? "");

  const manifestQuery = createQuery({
    queryKey: ["manual", "manifest"],
    queryFn: fetchManifest,
    staleTime: 5 * 60_000,
  });

  const articles = $derived($manifestQuery.data?.articles ?? []);
  const summary = $derived(articles.find((a) => a.slug === slug));
  const notFound = $derived(!$manifestQuery.isLoading && !!articles.length && !summary);
</script>

<PageShell title={notFound ? "Article not found" : (summary?.title ?? slug)} description={summary?.summary}>
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
    <ManualSidebar activeSlug={slug} />

    <section class="min-w-0">
      {#if notFound}
        <div class="rounded-md border border-warning/25 bg-warning-muted p-3 text-body">
          <p class="text-body-sm text-muted-foreground">
            No article in the manifest matches the slug <code class="rounded-md bg-muted px-1.5 py-0.5">{slug}</code>.
          </p>
          <a href={`${base}/manual`} class="mt-2 inline-flex text-body-sm font-medium text-primary hover:underline">Back to the manual</a>
        </div>
      {:else}
        <ArticleView {slug} {summary} />
      {/if}
    </section>
  </div>
</PageShell>
