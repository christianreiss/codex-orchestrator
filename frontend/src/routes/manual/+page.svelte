<script lang="ts">
  import { base } from "$app/paths";
  import { createQuery } from "@tanstack/svelte-query";
  import { PageShell, Section, StateBlock } from "$lib/components/page";
  import ManualSidebar from "$lib/components/manual/ManualSidebar.svelte";
  import { fetchManifest } from "$lib/api/manual";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";

  const manifestQuery = createQuery({
    queryKey: ["manual", "manifest"],
    queryFn: fetchManifest,
    staleTime: 5 * 60_000,
  });

  const articles = $derived($manifestQuery.data?.articles ?? []);

  // Featured: articles tagged "getting-started" if any, else the first
  // article in each of the first four sections.
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

<PageShell
  title="Manual"
  description={`Operator reference, generated from the codebase.${articles.length ? ` ${articles.length} articles.` : ""}`}
>
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
    <ManualSidebar />

    <div class="min-w-0">
      {#if $manifestQuery.isLoading}
        <StateBlock state="loading" rows={4} />
      {:else if featured.length}
        <Section title="Start here" description="Pick an article on the left, or jump into one of these.">
          <ul class="divide-y rounded-md border">
            {#each featured as article (article.slug)}
              <li>
                <a href={`${base}/manual/${article.slug}`} class="group flex items-start justify-between gap-3 px-3 py-2 hover:bg-accent">
                  <span class="min-w-0">
                    <span class="block truncate text-body font-medium">{article.title}</span>
                    {#if article.section}<span class="block text-caption text-muted-foreground">{article.section}</span>{/if}
                    <span class="line-clamp-2 text-body-sm text-muted-foreground">{article.summary}</span>
                  </span>
                  <ArrowRight class="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                </a>
              </li>
            {/each}
          </ul>
        </Section>
      {/if}
    </div>
  </div>
</PageShell>
