<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";
  import type { Engine, Presence } from "$lib/portal/types";
  import type { UnreadBadge } from "$lib/portal/unread";
  import EngineAvatar from "./EngineAvatar.svelte";

  /**
   * One Messages-style conversation cell, shared by the /go chat list and the
   * admin Active Clients directory: avatar with presence, name + time, one
   * line of preview, badge. Button attributes (id, aria-*, tabindex, handlers)
   * pass straight through -- never a `style` key, which the portal CSP blocks.
   */
  let {
    engine,
    presence,
    title,
    subtitle = "",
    time = "",
    preview,
    selected = false,
    needsYou = false,
    badge = null,
    ...rest
  }: {
    engine: Engine;
    presence: Presence;
    title: string;
    /** Muted text after the title, e.g. the username. */
    subtitle?: string;
    time?: string;
    preview: string;
    selected?: boolean;
    needsYou?: boolean;
    badge?: UnreadBadge;
  } & Omit<HTMLButtonAttributes, "title" | "style"> = $props();

  const dim = $derived((presence === "offline" || presence === "ended") && !needsYou);
</script>

<button
  type="button"
  class="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition
         focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring
         {selected ? 'bg-primary/15' : 'hover:bg-muted/70'}"
  {...rest}
>
  <EngineAvatar {engine} {presence} badge />

  <span class="min-w-0 flex-1">
    <span class="flex items-baseline gap-2">
      <span class="min-w-0 truncate text-body font-semibold {dim ? 'text-muted-foreground' : ''}">
        {title}{#if subtitle}<span class="font-normal text-muted-foreground">{" · "}{subtitle}</span>{/if}
      </span>
      <span class="ml-auto shrink-0 text-[11px] text-muted-foreground">{time}</span>
    </span>
    <span class="mt-0.5 flex items-center gap-2">
      <span
        class="min-w-0 flex-1 truncate text-caption
               {needsYou ? 'font-medium text-destructive' : 'text-muted-foreground'}"
      >{preview}</span>
      {#if badge?.kind === "attention"}
        <span
          class="grid h-[1.125rem] min-w-[1.125rem] shrink-0 place-items-center rounded-full bg-destructive px-1
                 text-[10px] font-bold text-destructive-foreground"
        >!<span class="sr-only">needs you</span></span>
      {:else if badge?.kind === "count"}
        <span
          class="grid h-[1.125rem] min-w-[1.125rem] shrink-0 place-items-center rounded-full bg-primary px-1.5
                 text-[10px] font-semibold text-primary-foreground"
        >{badge.value > 99 ? "99+" : badge.value}<span class="sr-only">unread</span></span>
      {:else if badge?.kind === "dot"}
        <span class="h-2.5 w-2.5 shrink-0 rounded-full bg-primary" aria-label="unread"></span>
      {/if}
    </span>
  </span>
</button>
