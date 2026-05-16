<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { cn } from "$lib/utils/cn";

  let { children }: { children?: Snippet } = $props();

  const path = $derived(page.url.pathname.replace(base, "") || "/");

  const TABS = [
    { href: "/authoring", label: "Skills", match: (p: string) => p === "/authoring" || p.startsWith("/authoring/skills") },
    { href: "/authoring/agents", label: "Agents", match: (p: string) => p.startsWith("/authoring/agents") },
    { href: "/authoring/memories", label: "Memories", match: (p: string) => p.startsWith("/authoring/memories") },
  ] as const;

  const activeHref = $derived(TABS.find((t) => t.match(path))?.href ?? "/authoring");
</script>

<PageHeader title="Authoring" subtitle="Skills, agents, memories" />

<nav class="mb-6" aria-label="Authoring sections">
  <div class="inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground">
    {#each TABS as tab (tab.href)}
      {@const active = tab.match(path)}
      <button
        type="button"
        class={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          active ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
        )}
        aria-current={active ? "page" : undefined}
        onclick={() => goto(`${base}${tab.href}`)}
      >
        {tab.label}
      </button>
    {/each}
  </div>
</nav>

{@render children?.()}
