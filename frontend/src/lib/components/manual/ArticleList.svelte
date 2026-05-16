<script lang="ts">
  import { base } from "$app/paths";
  import { cn } from "$lib/utils/cn";
  import type { ManualArticleSummary } from "$lib/api/types";

  type Props = {
    articles: ManualArticleSummary[];
    activeSlug?: string;
    query?: string;
  };

  let { articles, activeSlug, query = "" }: Props = $props();

  // Stable, manifest-order grouping by section.
  const grouped = $derived.by(() => {
    const sectionOrder: string[] = [];
    const sections: Map<string, ManualArticleSummary[]> = new Map();
    for (const a of articles) {
      const key = a.section || "Other";
      if (!sections.has(key)) {
        sections.set(key, []);
        sectionOrder.push(key);
      }
      sections.get(key)!.push(a);
    }
    return sectionOrder.map((s) => ({ section: s, items: sections.get(s)! }));
  });

  const isEmpty = $derived(articles.length === 0);
  const trimmedQuery = $derived(query.trim());
</script>

<nav aria-label="Manual articles" class="space-y-5">
  {#if isEmpty}
    <p class="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
      {#if trimmedQuery}
        No articles match "{trimmedQuery}"
      {:else}
        No articles available
      {/if}
    </p>
  {:else}
    {#each grouped as group (group.section)}
      <div>
        <p
          class="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {group.section}
        </p>
        <ul class="space-y-0.5">
          {#each group.items as article (article.slug)}
            {@const active = article.slug === activeSlug}
            <li>
              <a
                href={`${base}/manual/${article.slug}`}
                class={cn(
                  "block rounded-md px-2.5 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-[hsl(var(--sidebar-active))] text-white"
                    : "text-foreground/80 hover:bg-accent hover:text-foreground",
                )}
                aria-current={active ? "page" : undefined}
              >
                <span class="block truncate font-medium">{article.title}</span>
                {#if article.summary && !active}
                  <span class="mt-0.5 block truncate text-xs text-muted-foreground">
                    {article.summary}
                  </span>
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}
</nav>
