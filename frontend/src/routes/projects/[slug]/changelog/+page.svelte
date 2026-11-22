<script lang="ts">
  import { page } from "$app/state";
  import ChangelogTimeline from "$lib/components/projects/changelog/ChangelogTimeline.svelte";

  const slug = $derived(page.params.slug ?? "");
</script>

<div class="space-y-3">
  {#key slug}<ChangelogTimeline {slug} />{/key}
</div>
