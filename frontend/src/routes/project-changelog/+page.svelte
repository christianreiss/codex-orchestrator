<script lang="ts">
  /** Every project's changelog in one timeline. Outside /projects/… so it cannot shadow a project slug. */
  import { base } from "$app/paths";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { PageShell } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import ChangelogTimeline from "$lib/components/projects/changelog/ChangelogTimeline.svelte";
</script>

<PageShell title="Changelog" description="What agents and operators changed across all projects, and why. Newest first.">
  {#snippet actions()}
    <Button variant="outline" href={`${base}/projects`}><ArrowLeft class="h-4 w-4" /> Projects</Button>
  {/snippet}
  <div class="space-y-3">
    <ChangelogTimeline />
  </div>
</PageShell>
