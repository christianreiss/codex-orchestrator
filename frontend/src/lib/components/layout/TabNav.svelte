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
    /**
     * Base-inclusive path prefix that lights this tab, when it differs from
     * `href` (a tab linking to `/logs/events` that also owns `/logs/mcp`).
     */
    activePath?: string;
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
      const itemPath = stripBase(item.activePath ?? item.href);
      const matches = currentPath === itemPath || currentPath.startsWith(itemPath + "/");
      if (matches && (best === null || itemPath.length > best.length)) {
        best = itemPath;
      }
    }
    return best;
  });

  // On a phone the strip scrolls; bring the current tab into view so it is not clipped at the edge.
  let strip = $state<HTMLElement | null>(null);
  $effect(() => {
    activeHref;
    strip?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" });
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
  {@const active = activeHref !== null && stripBase(item.activePath ?? item.href) === activeHref}
  <a
    href={item.href}
    class={cn(
      "-mb-px inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      active
        ? "border-primary text-foreground"
        : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
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

<nav class={cn("min-w-0 max-w-full border-b", className)} {...rest}>
  <div bind:this={strip} class="flex min-w-0 gap-1 overflow-x-auto">
    {#each items as item (item.href)}
      {@render tab(item)}
    {/each}
  </div>
</nav>
