<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { PageShell, StateBlock } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import ArtifactEditor from "$lib/components/library/ArtifactEditor.svelte";
  import SkillEditor from "$lib/components/library/SkillEditor.svelte";
  import RoleEditor from "$lib/components/library/roles/RoleEditor.svelte";
  import { isArtifactType } from "$lib/components/library/library-types";

  // Skills are addressed by slug, the Claude-native types by name: the same URL segment.
  const type = $derived(page.params.type ?? "");
  const name = $derived(page.params.name ?? "");
</script>

<!-- Keyed so moving between two documents re-hydrates the editor from scratch. -->
{#key `${type}/${name}`}
  {#if type === "skills"}
    <SkillEditor slug={name} />
  {:else if type === "roles"}
    <RoleEditor slug={name} />
  {:else if isArtifactType(type)}
    <ArtifactEditor {type} slug={name} />
  {:else}
    <PageShell title="Not found" description="This Library type does not have documents to edit.">
      <StateBlock state="empty" message={`No Library type called "${type}"`} />
      <Button variant="outline" href={`${base}/library`} class="w-fit">Back to the Library</Button>
    </PageShell>
  {/if}
{/key}
