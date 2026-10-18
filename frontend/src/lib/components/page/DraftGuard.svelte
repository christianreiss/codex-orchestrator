<script lang="ts">
  import { beforeNavigate } from "$app/navigation";
  let { dirty = false }: { dirty?: boolean } = $props();
  beforeNavigate((navigation) => {
    if (!dirty) return;
    if (navigation.willUnload) navigation.cancel();
    else if (!window.confirm("Discard unsaved changes and leave this editor?")) navigation.cancel();
  });
</script>
<svelte:window onbeforeunload={(event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } }} />
