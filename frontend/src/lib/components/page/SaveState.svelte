<script lang="ts">
  import { ApiError } from "$lib/api/client";
  let { pending = false, error = null, dirty = false, saved = false }: {
    pending?: boolean; error?: unknown; dirty?: boolean; saved?: boolean;
  } = $props();
</script>
{#if error}
  <div role="alert" class="rounded-md border border-destructive/40 bg-destructive-muted p-3 text-body-sm text-destructive">
    <p>{error instanceof Error ? error.message : "The change could not be saved."}</p>
    <p>{error instanceof ApiError && error.status >= 400 && error.status < 500
      ? "The server rejected the change. Your draft is still here; correct it before saving again."
      : "Save not confirmed. Your draft is still here. Check the current server value before retrying; the request may have been accepted."}</p>
  </div>
{:else}
  <p role="status" class="text-body-sm text-muted-foreground">{pending ? "Saving… Waiting for server confirmation." : dirty ? "Unsaved changes. Use Save to apply them." : saved ? "Saved. Confirmed by the server." : "Changes are saved when you select Save."}</p>
{/if}
