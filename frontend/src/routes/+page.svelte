<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  onMount(() => {
    void goto(`${base}/dashboard`, { replaceState: true });
  });
</script>

<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
  Redirecting…
</div>
