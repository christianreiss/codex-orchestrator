<script lang="ts">
  /**
   * `/admin` is the URL an operator actually types, so this is the real front
   * door — it just forwards to the dashboard.
   *
   * It waits for the auth store to settle first. Redirecting immediately raced
   * the layout's own gate: on an unclaimed installation the gate sends you to
   * `/setup`, this sent you to `/dashboard`, and whichever landed last won.
   * The loser was usually the gate, so a brand-new install opened on a
   * dashboard full of 401s instead of the setup wizard.
   */
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { authStore } from "$lib/stores/auth";

  onMount(() => {
    const unsubscribe = authStore.subscribe((state) => {
      if (state.loading) return;
      // Unclaimed: the layout gate owns this navigation. Stand down.
      if (!state.enforced) return;
      void goto(`${base}/dashboard`, { replaceState: true });
    });
    return unsubscribe;
  });
</script>

<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
  Redirecting…
</div>
