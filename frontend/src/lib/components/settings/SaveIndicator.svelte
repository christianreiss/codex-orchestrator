<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Loader2 from "@lucide/svelte/icons/loader-2";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { formatDistanceToNow } from "date-fns";

  type Props = {
    status?: "idle" | "saving" | "saved" | "error";
    savedAt?: Date | string | null;
    error?: string | null;
  };

  let { status = "idle", savedAt = null, error = null }: Props = $props();

  const savedAtDate = $derived.by(() => {
    if (!savedAt) return null;
    if (savedAt instanceof Date) return savedAt;
    const parsed = new Date(savedAt);
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
  });

  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(id);
  });

  const relative = $derived.by(() => {
    if (!savedAtDate) return null;
    // touch `now` to force recomputation
    void now;
    return formatDistanceToNow(savedAtDate, { addSuffix: true });
  });
</script>

<div class="flex w-full items-center justify-between text-xs text-muted-foreground">
  {#if status === "saving"}
    <span class="inline-flex items-center gap-1.5 text-muted-foreground">
      <Loader2 class="h-3 w-3 animate-spin" />
      Saving…
    </span>
  {:else if status === "error"}
    <span class="inline-flex items-center gap-1.5 text-destructive">
      <TriangleAlert class="h-3 w-3" />
      {error ?? "Save failed"}
    </span>
  {:else if status === "saved"}
    <span class="inline-flex items-center gap-1.5 text-success">
      <Check class="h-3 w-3" />
      Saved
    </span>
  {:else}
    <span class="text-muted-foreground/60">&nbsp;</span>
  {/if}
  {#if relative}
    <span class="tabular-nums">Last updated {relative}</span>
  {/if}
</div>
