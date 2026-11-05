<script lang="ts">
  /** Loading, error, no-access and empty states for any list or panel. One look, one wording. */
  import type { Component, Snippet } from "svelte";
  import AlertCircle from "@lucide/svelte/icons/circle-alert";
  import Lock from "@lucide/svelte/icons/lock";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import { accessDenied, accessDeniedText } from "$lib/api/access-denied";

  type Props = {
    state: "loading" | "error" | "denied" | "empty";
    /** Error text, or the empty/denied title. */
    message?: string;
    description?: string;
    icon?: Component;
    onRetry?: () => void;
    rows?: number;
    action?: Snippet;
    /** For `denied`: the capability the account lacks, when known. */
    capability?: string | null;
    /** For `error`: the failure itself. A 403 renders as `denied` instead, without Retry. */
    cause?: unknown;
  };
  let { state, message, description, icon, onRetry, rows = 4, action, capability = null, cause }: Props = $props();

  const denial = $derived(state === "error" ? accessDenied(cause) : null);
  const denied = $derived(state === "denied" || denial !== null);
</script>

{#if state === "loading"}
  <div class="space-y-2" role="status" aria-label="Loading">
    {#each Array(rows) as _, i (i)}<Skeleton class="h-9 w-full" />{/each}
  </div>
{:else if denied}
  <EmptyState
    icon={icon ?? Lock}
    title={denial ? "No access" : (message ?? "No access")}
    description={denial ? accessDeniedText(denial.capability) : (description ?? accessDeniedText(capability))}
    {action}
    size="sm"
    class="py-8"
  />
{:else if state === "error"}
  <div class="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive-muted px-3 py-2 text-body-sm text-destructive-muted-foreground" role="alert">
    <AlertCircle class="h-4 w-4 shrink-0" />
    <span class="min-w-0 flex-1">{message ?? "Could not load this."}</span>
    {#if onRetry}<Button size="sm" variant="outline" onclick={onRetry}>Retry</Button>{/if}
  </div>
{:else}
  <EmptyState {icon} title={message ?? "Nothing here yet"} {description} {action} size="sm" class="py-8" />
{/if}
