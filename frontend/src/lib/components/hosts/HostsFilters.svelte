<script lang="ts">
  /** The one status filter (segmented) and the less common attribute filters behind "More filters". */
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import Check from "@lucide/svelte/icons/check";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils/cn";
  import { FLAG_OPTIONS, STATUS_OPTIONS, type HostsListState } from "./hostsListState.svelte";

  let { state: list }: { state: HostsListState } = $props();
  const count = (id: string): number | undefined =>
    id === "all" ? list.counts.total : id === "online" ? list.counts.online : id === "offline" ? list.counts.offline : id === "attention" ? list.counts.attention : undefined;
</script>

<div class="grid min-h-9 w-full max-w-full grid-cols-2 gap-1 rounded-md bg-card sm:inline-flex sm:w-auto sm:gap-0 sm:border sm:border-input" role="group" aria-label="Show hosts">
  {#each STATUS_OPTIONS as option (option.id)}
    {@const active = list.status === option.id}
    <button
      type="button"
      aria-pressed={active}
      class={cn(
        "inline-flex min-h-9 min-w-0 items-center justify-center gap-1.5 border-input px-3 py-1 text-body-sm max-sm:flex-wrap max-sm:rounded-md max-sm:border max-sm:px-2 sm:shrink-0 sm:whitespace-nowrap sm:border-r transition-colors sm:last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
      onclick={() => list.setStatus(option.id)}
    >
      {option.label}
      <span class={cn("tabular-nums", active ? "text-primary-foreground/80" : "text-muted-foreground")}>{count(option.id)}</span>
    </button>
  {/each}
</div>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline">
        <SlidersHorizontal class="h-4 w-4" /> More filters{list.flags.length ? ` (${list.flags.length})` : ""}
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="start" class="w-60">
    {#each FLAG_OPTIONS as option (option.id)}
      <DropdownMenu.Item onclick={() => list.toggleFlag(option.id)} aria-checked={list.flags.includes(option.id)} role="menuitemcheckbox">
        <span class="flex h-4 w-4 items-center justify-center">{#if list.flags.includes(option.id)}<Check class="h-4 w-4" />{/if}</span>
        <span class="flex-1">{option.label}</span>
        <span class="text-caption text-muted-foreground">{option.hint}</span>
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
