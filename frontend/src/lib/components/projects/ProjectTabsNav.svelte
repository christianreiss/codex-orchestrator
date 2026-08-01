<script lang="ts">
  import { base } from "$app/paths";
  import { cn } from "$lib/utils/cn";

  type Props = { slug: string; currentPath: string };
  let { slug, currentPath }: Props = $props();

  const root = $derived(`${base}/projects/${encodeURIComponent(slug)}`);

  const tabs = $derived([
    { label: "Identity", href: root, match: (p: string) => p === root || p === `${root}/` },
    {
      label: "Notes",
      href: `${root}/notes`,
      match: (p: string) => p.startsWith(`${root}/notes`),
    },
    {
      label: "Todos",
      href: `${root}/todos`,
      match: (p: string) => p.startsWith(`${root}/todos`),
    },
    {
      label: "Files",
      href: `${root}/files`,
      match: (p: string) => p.startsWith(`${root}/files`),
    },
    {
      label: "Feedback",
      href: `${root}/feedback`,
      match: (p: string) => p.startsWith(`${root}/feedback`),
    },
    {
      label: "Activity",
      href: `${root}/activity`,
      match: (p: string) => p.startsWith(`${root}/activity`),
    },
  ]);
</script>

<nav class="overflow-x-auto rounded-md border border-border/60 bg-card/70 p-1" aria-label="Project sections">
  <div class="flex min-w-max gap-1">
    {#each tabs as tab (tab.label)}
      {@const active = tab.match(currentPath)}
      <a
        href={tab.href}
        class={cn(
          "rounded-md px-3 py-2 text-sm font-medium transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        aria-current={active ? "page" : undefined}
      >
        {tab.label}
      </a>
    {/each}
  </div>
</nav>
