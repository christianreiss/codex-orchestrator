<script lang="ts">
  import { base } from "$app/paths";
  import * as Card from "$lib/components/ui/card";
  import { relativeTime } from "$lib/utils/format";
  import type { ProjectSummary } from "$lib/api/types";

  type Props = { project: ProjectSummary };
  let { project }: Props = $props();

  const href = $derived(`${base}/projects/${encodeURIComponent(project.slug)}`);
  const title = $derived(project.title || project.slug);
  const description = $derived(project.description || "");
  const counts = $derived(project.counts);
</script>

<a
  {href}
  class="group block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
>
  <Card.Root
    class="flex h-full flex-col transition-colors group-hover:border-foreground/20 group-hover:bg-accent/40"
  >
    <Card.Header class="flex-1">
      <Card.Title class="truncate text-base">{title}</Card.Title>
      <Card.Description class="font-mono text-xs">{project.slug}</Card.Description>
      {#if description}
        <p class="mt-2 line-clamp-3 text-sm text-muted-foreground">{description}</p>
      {/if}
    </Card.Header>
    <Card.Footer class="flex items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
      {#if counts}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span title="Notes"><span class="font-semibold text-foreground">{counts.notes}</span> notes</span>
          <span title="Open todos"
            ><span class="font-semibold text-foreground">{counts.open_todos}</span> todos</span
          >
          <span title="Files"
            ><span class="font-semibold text-foreground">{counts.files}</span> files</span
          >
          <span title="Feedback"
            ><span class="font-semibold text-foreground">{counts.feedback}</span> feedback</span
          >
        </div>
      {:else}
        <span>—</span>
      {/if}
      <span class="shrink-0 whitespace-nowrap">{relativeTime(project.updated_at)}</span>
    </Card.Footer>
  </Card.Root>
</a>
