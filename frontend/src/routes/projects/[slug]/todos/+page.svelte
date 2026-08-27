<script lang="ts">
  /**
   * Never rendered: `+page.ts` redirects to the board before this mounts.
   *
   * It exists because a route with only a `+page.ts` is not a route at all —
   * SvelteKit needs the component to match the path, so without this file the
   * old `/todos` URL simply does not resolve and the redirect never runs. That
   * failure is silent: `svelte-check` and the build both pass.
   */
</script>

<p class="text-sm text-muted-foreground">Redirecting to the board…</p>
