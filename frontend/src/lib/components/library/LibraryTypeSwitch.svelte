<script lang="ts">
  /**
   * The Library's type filter: one segmented strip of links, shared by the
   * list and the agent-rules screen so the whole hub reads as one page.
   */
  import { base } from "$app/paths";
  import { cn } from "$lib/utils/cn";
  import { LIBRARY_TYPES, libraryListHref, type LibraryTypeId } from "./library-types";

  let { active }: { active: LibraryTypeId } = $props();
</script>

<nav aria-label="Library content type" class="-mx-1 overflow-x-auto px-1">
  <ul class="inline-flex min-w-max gap-0.5 rounded-md border bg-muted/40 p-0.5">
    {#each LIBRARY_TYPES as type (type.id)}
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
