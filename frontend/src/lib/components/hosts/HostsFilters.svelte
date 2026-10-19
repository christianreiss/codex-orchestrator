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

<div class="inline-flex h-9 max-w-full overflow-x-auto rounded-md border border-input bg-card max-sm:flex max-sm:w-full" role="group" aria-label="Show hosts">
  {#each STATUS_OPTIONS as option (option.id)}
    {@const active = list.status === option.id}
    <button
      type="button"
      aria-pressed={active}
      class={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-input px-3 text-body-sm max-sm:flex-1 max-sm:justify-center max-sm:gap-1 max-sm:px-1.5 transition-colors last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
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
