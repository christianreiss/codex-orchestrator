<script lang="ts">
  /** Loading, error and empty states for any list or panel. One look, one wording. */
  import type { Component, Snippet } from "svelte";
  import AlertCircle from "@lucide/svelte/icons/circle-alert";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { EmptyState } from "$lib/components/ui/empty-state";

  type Props = {
    state: "loading" | "error" | "empty";
    /** Error text, or the empty-state title. */
    message?: string;
    description?: string;
    icon?: Component;
    onRetry?: () => void;
    rows?: number;
    action?: Snippet;
  };
  let { state, message, description, icon, onRetry, rows = 4, action }: Props = $props();
</script>

{#if state === "loading"}
  <div class="space-y-2" role="status" aria-label="Loading">
    {#each Array(rows) as _, i (i)}<Skeleton class="h-9 w-full" />{/each}
  </div>
{:else if state === "error"}
  <div class="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive-muted px-3 py-2 text-body-sm text-destructive-muted-foreground" role="alert">
    <AlertCircle class="h-4 w-4 shrink-0" />
    <span class="min-w-0 flex-1">{message ?? "Could not load this."}</span>
    {#if onRetry}<Button size="sm" variant="outline" onclick={onRetry}>Retry</Button>{/if}
  </div>
{:else}
  <EmptyState {icon} title={message ?? "Nothing here yet"} {description} {action} size="sm" class="py-8" />
{/if}
