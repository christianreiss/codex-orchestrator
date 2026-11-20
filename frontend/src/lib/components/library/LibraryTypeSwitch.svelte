<script lang="ts">
  /**
   * The Library's type filter: one segmented strip of links, shared by the
   * list and the agent-rules screen so the whole hub reads as one page.
   */
  import { base } from "$app/paths";
  import { cn } from "$lib/utils/cn";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { CLAUDE_ONLY_NOTE, libraryListHref, libraryTypeMeta, offeredLibraryTypes, type LibraryTypeId } from "./library-types";

  let { active }: { active: LibraryTypeId } = $props();
  const fleet = useFleetEngines();
  const types = $derived(offeredLibraryTypes($fleet.isEnabled("claude")));
</script>

<nav aria-label="Library content type" class="min-w-0 max-w-full overflow-x-auto">
  <ul class="inline-flex min-w-max gap-0.5 rounded-md border bg-muted/40 p-0.5">
    {#each types as type (type.id)}
      <li>
        <a
          href={`${base}${libraryListHref(type.id)}`}
          aria-current={active === type.id ? "page" : undefined}
          title={type.canonical ? `${type.label} (${type.canonical})` : undefined}
          class={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-body-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active === type.id
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <type.icon class="h-4 w-4" aria-hidden="true" />
          {type.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>
{#if libraryTypeMeta(active).claudeOnly}
  <p class="mt-1.5 text-caption text-muted-foreground">{CLAUDE_ONLY_NOTE}</p>
{/if}
