<script lang="ts">
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import { PageShell } from "$lib/components/page";
  import LibraryList from "$lib/components/library/LibraryList.svelte";
  import LibraryTypeSwitch from "$lib/components/library/LibraryTypeSwitch.svelte";
  import MemoriesPanel from "$lib/components/library/memories/MemoriesPanel.svelte";
  import RolesPanel from "$lib/components/library/roles/RolesPanel.svelte";
  import { DOC_LISTS, isDocType, libraryTypeMeta, parseLibraryType } from "$lib/components/library/library-types";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { ApiError } from "$lib/api/client";
  import { rolesApi, rolesKeys } from "$lib/api/roles";
  import { authStore } from "$lib/stores/auth";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";

  const requested = $derived(page.url.searchParams.get("type"));
  const type = $derived(parseLibraryType(requested));
  const meta = $derived(libraryTypeMeta(type));

  // The roles module switch has its one editable home on the roles view.
  const qc = useQueryClient();
  const canManageContent = $derived($authStore.can("content.manage"));
  const rolesState = createQuery(
    reactiveOptions(() => ({ queryKey: [...rolesKeys.list()], queryFn: () => rolesApi.list(), enabled: type === "roles" })),
  );
  const rolesToggle = createMutation({
    mutationFn: (next: boolean) => rolesApi.setState(next),
    onSuccess: (result) => {
      toast.success(result.enabled ? "Agent roles turned on" : "Agent roles turned off");
      void qc.invalidateQueries({ queryKey: [...rolesKeys.all] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Could not change the roles module"),
  });

  // Agent rules is its own screen; `?type=agent-rules` is only a way to name it.
  $effect(() => {
    if (requested === "agent-rules") void goto(`${base}/library/agent-rules`, { replaceState: true });
  });
</script>

<PageShell
  title="Library"
  description={meta.description}
  width="wide"
  toggle={type === "roles" && $rolesState.data
    ? {
        label: "Agent roles",
        checked: $rolesState.data.enabled,
        disabled: !canManageContent || $rolesToggle.isPending,
        onChange: (next: boolean) => $rolesToggle.mutate(next),
      }
    : undefined}
>
  {#snippet subheader()}
    <LibraryTypeSwitch active={type} />
  {/snippet}
  {#key type}
    {#if type === "memories"}
      <MemoriesPanel />
    {:else if type === "roles"}
      <RolesPanel />
    {:else if isDocType(type)}
      <LibraryList config={DOC_LISTS[type]} />
    {/if}
  {/key}
</PageShell>
