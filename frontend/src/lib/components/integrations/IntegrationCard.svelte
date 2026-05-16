<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { cn } from "$lib/utils/cn";

  type Status = "connected" | "disconnected" | "unconfigured" | "error";

  type Props = {
    name: string;
    description: string;
    href: string;
    icon: Component;
    status: Status;
    /** Pre-formatted right-hand line under the title (e.g. "Last sync 4 minutes ago"). */
    detail?: string | null;
    /** Loading skeleton — renders the card chrome without status. */
    loading?: boolean;
    class?: string;
    extra?: Snippet;
  };

  let { name, description, href, icon: Icon, status, detail, loading = false, class: className, extra }: Props = $props();

  const statusLabel = $derived(
    {
      connected: "Connected",
      disconnected: "Disconnected",
      unconfigured: "Not configured",
      error: "Error",
    }[status],
  );

  const statusVariant = $derived(
    ({
      connected: "success",
      disconnected: "secondary",
      unconfigured: "outline",
      error: "destructive",
    } as const)[status],
  );

  function open() {
    void goto(base + href);
  }
</script>

<Card
  class={cn(
    "group cursor-pointer transition-shadow hover:shadow-md focus-within:ring-2 focus-within:ring-ring",
    className,
  )}
>
  <button
    type="button"
    class="block w-full text-left focus:outline-none"
    onclick={open}
    aria-label={`Open ${name} integration`}
  >
    <CardHeader class="flex flex-row items-start justify-between gap-4 space-y-0">
      <div class="flex items-start gap-3 min-w-0">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
          <Icon class="h-5 w-5" />
        </div>
        <div class="min-w-0">
          <CardTitle class="truncate text-base">{name}</CardTitle>
          <CardDescription class="mt-1 line-clamp-2">{description}</CardDescription>
        </div>
      </div>
      {#if !loading}
        <Badge variant={statusVariant} class="shrink-0">{statusLabel}</Badge>
      {/if}
    </CardHeader>
    <CardContent class="pt-0">
      <div class="flex items-center justify-between text-xs text-muted-foreground">
        {#if loading}
          <span class="h-4 w-32 animate-pulse rounded bg-muted"></span>
        {:else if detail}
          <span class="truncate">{detail}</span>
        {:else}
          <span class="text-muted-foreground/70">No activity yet</span>
        {/if}
        <span class="opacity-0 transition-opacity group-hover:opacity-100">Open →</span>
      </div>
      {#if extra}
        <div class="mt-3">
          {@render extra()}
        </div>
      {/if}
    </CardContent>
  </button>
</Card>
