<script lang="ts">
  /** The first thing on the Overview: what is wrong, and a link to where it is fixed. */
  import { base } from "$app/paths";
  import { Section, StateBlock } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils/cn";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Info from "@lucide/svelte/icons/info";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import type { AttentionItem } from "./attention";

  type Props = {
    items: AttentionItem[];
    /** Sources that have not answered yet; an empty list is not "all clear" until they do. */
    loading?: boolean;
  };
  let { items, loading = false }: Props = $props();

  const icons = { danger: CircleAlert, warning: TriangleAlert, info: Info } as const;
  const tones = { danger: "text-destructive", warning: "text-warning", info: "text-info" } as const;
</script>

<Section title="Needs attention" description={items.length ? `${items.length} ${items.length === 1 ? "item" : "items"}, most urgent first.` : undefined}>
  {#if loading && items.length === 0}
    <StateBlock state="loading" rows={2} />
  {:else if items.length === 0}
    <p class="flex items-center gap-2 rounded-md border px-3 py-2 text-body text-muted-foreground">
      <CircleCheck class="h-4 w-4 text-success" aria-hidden="true" /> Nothing needs attention.
    </p>
  {:else}
    <ul class="divide-y rounded-md border" aria-label="Items needing attention">
      {#each items as item (item.id)}
        {@const Icon = icons[item.tone]}
        <li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <Icon class={cn("h-4 w-4 shrink-0", tones[item.tone])} aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="text-body font-medium">{item.title}</p>
            {#if item.detail}<p class="truncate text-body-sm text-muted-foreground" title={item.detail}>{item.detail}</p>{/if}
          </div>
          <Button size="sm" variant="outline" href={`${base}${item.href}`}>{item.action}</Button>
        </li>
      {/each}
    </ul>
  {/if}
</Section>
