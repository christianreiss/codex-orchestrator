<script lang="ts">
  import { base } from "$app/paths";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { relativeTime } from "$lib/utils/format";
  import type { ProjectSummary } from "$lib/api/types";

  type Props = {
    project: ProjectSummary;
    onDelete?: (project: ProjectSummary) => void;
  };
  let { project, onDelete }: Props = $props();

  const href = $derived(`${base}/projects/${encodeURIComponent(project.slug)}`);
  const title = $derived(project.title || project.slug);
  const description = $derived(project.description || "");
  const counts = $derived(project.counts);
</script>

<Card.Root class="group flex h-full flex-col transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/20 hover:shadow-lg">
  <a
    {href}
    class="block flex-1 rounded-t-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
  >
    <Card.Header class="h-full">
      <Card.Title class="truncate text-base">{title}</Card.Title>
      <Card.Description class="font-mono text-xs">{project.slug}</Card.Description>
      {#if description}
        <p class="mt-2 line-clamp-3 text-sm text-muted-foreground">{description}</p>
      {/if}
    </Card.Header>
  </a>
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
    <div class="flex shrink-0 items-center gap-1.5">
      <span class="whitespace-nowrap">{relativeTime(project.updated_at)}</span>
      {#if onDelete}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="h-8 w-8 text-muted-foreground hover:text-destructive"
          title="Delete project"
          aria-label={`Delete project ${title}`}
          onclick={() => onDelete?.(project)}
        >
          <Trash2 class="h-4 w-4" />
        </Button>
      {/if}
    </div>
  </Card.Footer>
</Card.Root>
