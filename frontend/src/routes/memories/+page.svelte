<script lang="ts">
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import MemoriesPage from "../authoring/memories/+page.svelte";
</script>

<PageHeader title="Memories" subtitle="Switch between the atlas and inventory without rendering two large workspaces at once." />
<MemoriesPage />
