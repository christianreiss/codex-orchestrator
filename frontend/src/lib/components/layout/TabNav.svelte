<script lang="ts">
  import type { Component } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { cn } from "$lib/utils/cn";
  import { Badge } from "$lib/components/ui/badge";

  export type TabNavItem = {
    /** Must be base-inclusive (e.g. `${base}/settings`), same contract as Button's `href`. */
    href: string;
    label: string;
    icon?: Component;
    badge?: string | number;
    group?: string;
  };

  type Props = HTMLAttributes<HTMLElement> & {
    items: TabNavItem[];
    class?: string;
  };

  let { items, class: className, ...rest }: Props = $props();

  // `path.replace(base, "")` (the pattern used elsewhere in this codebase) would
  // mis-strip a route that merely starts with the same characters as `base`
  // (e.g. base "/admin" against a hypothetical "/administrator" route); anchor
  // the check on a full path segment instead.
  function stripBase(path: string): string {
    if (path === base) return "/";
    if (base && path.startsWith(base + "/")) return path.slice(base.length);
    return path;
  }

  const currentPath = $derived(stripBase(page.url.pathname));

  // Longest matching href wins, so a nested route's tab (e.g. /authoring/agents)
  // takes precedence over its parent (e.g. /authoring) instead of both lighting up.
  const activeHref = $derived.by(() => {
    let best: string | null = null;
    for (const item of items) {
      const itemPath = stripBase(item.href);
      const matches = currentPath === itemPath || currentPath.startsWith(itemPath + "/");
      if (matches && (best === null || itemPath.length > best.length)) {
        best = itemPath;
      }
    }
    return best;
  });

  type Group = { group: string | undefined; items: TabNavItem[] };
  const groups = $derived.by(() => {
    const out: Group[] = [];
    for (const item of items) {
      let bucket = out.find((g) => g.group === item.group);
      if (!bucket) {
        bucket = { group: item.group, items: [] };
        out.push(bucket);
      }
      bucket.items.push(item);
    }
    return out;
  });
</script>

{#snippet tab(item: TabNavItem)}
  {@const active = activeHref !== null && stripBase(item.href) === activeHref}
  <a
    href={item.href}
    class={cn(
      "inline-flex min-h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active
        ? "bg-card text-foreground"
        : "text-muted-foreground hover:bg-card/50 hover:text-foreground",
    )}
    aria-current={active ? "page" : undefined}
  >
    {#if item.icon}
      <item.icon class="h-4 w-4" />
    {/if}
    {item.label}
    {#if item.badge !== undefined}
      <Badge variant="secondary">{item.badge}</Badge>
    {/if}
  </a>
{/snippet}

<nav class={cn(className)} {...rest}>
  <div class="flex flex-col gap-4">
    {#each groups as g (g.group ?? "_ungrouped")}
      <div class="min-w-0">
        {#if g.group}
          <p class="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {g.group}
          </p>
        {/if}
        <div class="flex min-w-0 gap-1 overflow-x-auto rounded-md border border-border/70 bg-muted/60 p-0.5">
          {#each g.items as item (item.href)}
            {@render tab(item)}
          {/each}
        </div>
      </div>
    {/each}
  </div>
</nav>
