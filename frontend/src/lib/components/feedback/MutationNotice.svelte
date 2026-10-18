<script lang="ts">
  /** Persistent fallback for actions whose toast disappears. No request payload is retained. */
  import { onMount, tick } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { ApiError } from "$lib/api/client";
  import { Button } from "$lib/components/ui/button";
  let { modal = false }: { modal?: boolean } = $props();
  const client = useQueryClient();
  let failures = $state<Array<{ id: number; message: string; uncertain: boolean }>>([]);
  onMount(() => client.getMutationCache().subscribe(async (event) => {
    if (event.type !== "updated") return;
    const { mutation } = event;
    if (event.action.type === "success" || event.action.type === "pending") {
      failures = failures.filter((failure) => failure.id !== mutation.mutationId);
    } else if (event.action.type === "error") {
      const error = mutation.state.error;
      const message = error instanceof Error ? error.message : "The action failed.";
      await tick();
      // Query observers batch notifications; wait for the task-specific error to render.
      await new Promise((resolve) => setTimeout(resolve, 80));
      // Prefer the task's own inline error. Only the active modal owns fallback
      // feedback while open; the inert page must not duplicate it.
      if (mutation.state.status !== "error") return;
      if (!modal && document.querySelector('[role="dialog"][data-state="open"]')) return;
      const root = modal ? [...document.querySelectorAll('[role="dialog"][data-state="open"]')].at(-1) : document.querySelector("main");
      const inline = [...(root?.querySelectorAll('[role="alert"]') ?? [])].some((node) =>
        !node.closest('[data-mutation-fallback], [data-sonner-toast]') && (modal || node.textContent?.includes(message)));
      if (inline) return;
      failures = [...failures.filter((failure) => failure.id !== mutation.mutationId), {
        id: mutation.mutationId,
        message,
        uncertain: !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      }];
    }
  }));
</script>
{#each failures as failure (failure.id)}
  <div data-mutation-fallback role="alert" class="flex min-w-0 flex-wrap items-start gap-2 rounded-md border border-destructive/40 bg-destructive-muted p-3 text-body-sm text-destructive-muted-foreground">
    <div class="min-w-0 flex-1 [overflow-wrap:anywhere]">
      <p class="font-medium">{failure.message}</p>
      {#if failure.uncertain}<p>Outcome not confirmed. Check the current server state before repeating this action.</p>{/if}
    </div>
    <Button variant="outline" size="sm" onclick={() => failures = failures.filter((item) => item.id !== failure.id)}>Dismiss error</Button>
  </div>
{/each}
