<script lang="ts">
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import { PageShell } from "$lib/components/page";
  import LibraryList from "$lib/components/library/LibraryList.svelte";
  import LibraryTypeSwitch from "$lib/components/library/LibraryTypeSwitch.svelte";
  import MemoriesPanel from "$lib/components/library/memories/MemoriesPanel.svelte";
  import { DOC_LISTS, isDocType, libraryTypeMeta, parseLibraryType } from "$lib/components/library/library-types";

  const requested = $derived(page.url.searchParams.get("type"));
  const type = $derived(parseLibraryType(requested));
  const meta = $derived(libraryTypeMeta(type));

  // Agent rules is its own screen; `?type=agent-rules` is only a way to name it.
  $effect(() => {
    if (requested === "agent-rules") void goto(`${base}/library/agent-rules`, { replaceState: true });
  });
</script>

<PageShell title="Library" description={meta.description} width="wide">
  {#snippet subheader()}
    <LibraryTypeSwitch active={type} />
  {/snippet}
  {#key type}
    {#if type === "memories"}
      <MemoriesPanel />
    {:else if isDocType(type)}
      <LibraryList config={DOC_LISTS[type]} />
    {/if}
  {/key}
</PageShell>
