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

<nav class="border-b" aria-label="Project sections">
  <div class="-mb-px flex flex-wrap gap-1 overflow-x-auto">
    {#each tabs as tab (tab.label)}
      {@const active = tab.match(currentPath)}
      <a
        href={tab.href}
        class={cn(
          "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
          active
            ? "border-foreground text-foreground"
            : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
        )}
        aria-current={active ? "page" : undefined}
      >
        {tab.label}
      </a>
    {/each}
  </div>
</nav>
