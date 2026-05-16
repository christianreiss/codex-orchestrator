<script lang="ts">
  import { onMount } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Item = { id: string; label: string };
  type Props = { items: Item[]; class?: string };
  let { items, class: className }: Props = $props();

  let activeId = $state("");
  $effect(() => {
    if (activeId === "" && items.length > 0) {
      activeId = items[0].id;
    }
  });

  onMount(() => {
    if (typeof window === "undefined") return;
    const sections = items
      .map((it) => document.getElementById(it.id))
      .filter((el): el is HTMLElement => el !== null);

    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          activeId = visible[0].target.id;
        }
      },
      {
        // Trigger when section top is in the upper third of the viewport.
        rootMargin: "-20% 0px -60% 0px",
        threshold: [0, 0.1, 0.5],
      },
    );

    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  });

  function handleClick(event: MouseEvent, id: string) {
    event.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    activeId = id;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", "#" + id);
  }
</script>

<!-- Desktop TOC: vertical sticky list. -->
<nav class={cn("hidden lg:block", className)} aria-label="Settings sections">
  <div class="sticky top-20">
    <p class="mb-3 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      On this page
    </p>
    <ul class="space-y-0.5">
      {#each items as item (item.id)}
        <li>
          <a
            href={"#" + item.id}
            onclick={(e) => handleClick(e, item.id)}
            class={cn(
              "block rounded-md border-l-2 px-3 py-1.5 text-sm transition-colors",
              activeId === item.id
                ? "border-primary bg-muted font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            aria-current={activeId === item.id ? "true" : undefined}
          >
            {item.label}
          </a>
        </li>
      {/each}
    </ul>
  </div>
</nav>

<!-- Mobile TOC: sticky horizontal scroll bar. -->
<nav
  class={cn(
    "sticky top-0 z-10 -mx-4 mb-4 overflow-x-auto border-b bg-background/80 px-4 py-2 backdrop-blur lg:hidden",
    className,
  )}
  aria-label="Settings sections"
>
  <ul class="flex w-max gap-1">
    {#each items as item (item.id)}
      <li>
        <a
          href={"#" + item.id}
          onclick={(e) => handleClick(e, item.id)}
          class={cn(
            "whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors",
            activeId === item.id
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80",
          )}
          aria-current={activeId === item.id ? "true" : undefined}
        >
          {item.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>
