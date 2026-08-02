<script lang="ts">
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { ProjectDetailProject } from "$lib/api/types";
  import { excerptRoster } from "./roster-excerpt";

  type Props = {
    project: ProjectDetailProject | null;
    loading?: boolean;
    class?: string;
  };
  let { project, loading = false, class: className }: Props = $props();

  const about = $derived(project?.about ?? null);
  const title = $derived(about?.title || about?.name || project?.slug || "");
  const description = $derived(about?.description || "No description yet.");
  const roster = $derived(project ? excerptRoster(project.roster_markdown) : "");
</script>

{#if loading}
  <Skeleton class={`h-28 w-full ${className ?? ""}`} />
{:else if project}
  <div class={`rounded-md border bg-card p-4 ${className ?? ""}`}>
    <div class="flex items-baseline justify-between gap-3">
      <h3 class="truncate text-sm font-semibold">{title}</h3>
      <code class="shrink-0 text-xs text-muted-foreground">{project.slug}</code>
    </div>
    <p class="mt-1.5 text-sm text-muted-foreground">{description}</p>
    {#if roster}
      <p class="mt-2 whitespace-pre-line text-xs text-muted-foreground">{roster}</p>
    {/if}
    <dl class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <div><dt class="inline font-medium text-foreground">{project.counts.open_todos}</dt> open todos</div>
      <div><dt class="inline font-medium text-foreground">{project.counts.notes}</dt> notes</div>
      <div><dt class="inline font-medium text-foreground">{project.counts.files}</dt> files</div>
    </dl>
  </div>
{/if}
