<script lang="ts">
  import BellIcon from "@lucide/svelte/icons/bell";
  import BellOffIcon from "@lucide/svelte/icons/bell-off";
  import CheckCheckIcon from "@lucide/svelte/icons/check-check";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import SearchIcon from "@lucide/svelte/icons/search";
  import { GROUP_LABEL, groupAgents, matchesAgent } from "$lib/portal/presence";
  import type { Portal } from "../../lib/portal-state.svelte";
  import {
    notificationPermission,
    requestNotificationPermission,
    setNotifyBrokenHandler,
  } from "$lib/portal/browser";
  import ChatListItem from "./ChatListItem.svelte";

  let { portal, onselect }: { portal: Portal; onselect: (id: string) => void } = $props();

  let query = $state("");

  // One list, Messages style: status groups still decide the order ("Needs
  // you" first, ended last) but no longer each get a heading.
  const groups = $derived(groupAgents(portal.agents.filter((agent) => matchesAgent(agent, query)), portal.now));
  const live = $derived(groups.filter((group) => group.key !== "ended").flatMap((group) => group.agents));
  const ended = $derived(groups.find((group) => group.key === "ended")?.agents ?? []);
  // A search looks through ended sessions too, without making anyone expand them.
  const endedShown = $derived(portal.prefs.endedOpen || query.trim() !== "");
  const flat = $derived(endedShown ? [...live, ...ended] : live);
  let permission = $state(notificationPermission());

  // Some browsers only reveal that notifications are unusable when the first
  // one is constructed. Reflect that instead of leaving the bell lit and inert.
  setNotifyBrokenHandler(() => {
    permission = "unsupported";
    portal.setPrefs({ notify: false });
  });

  const bellLabel = $derived(
    permission === "denied"
      ? "Notifications are blocked in your browser settings"
      : permission === "unsupported"
        ? "This browser cannot show notifications"
        : portal.prefs.notify
          ? "Turn off notifications"
          : "Notify me when I am needed",
  );

  async function toggleNotify() {
    if (portal.prefs.notify) {
      portal.setPrefs({ notify: false });
      return;
    }
    // Must happen inside the click; browsers reject a page-load request.
    const result = await requestNotificationPermission();
    permission = result;
    portal.setPrefs({ notify: result === "granted" });
  }

  /**
   * Mail-client behaviour: arrows move focus and open in one step.
   *
   * Bound to each row button rather than the list, so the listener sits on an
   * interactive element and roving tabindex keeps the whole list one tab stop.
   */
  function onKeydown(event: KeyboardEvent) {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = flat.findIndex((agent) => agent.id === portal.selectedId);
    const last = flat.length - 1;
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? last
      : event.key === "ArrowDown" ? Math.min(last, index + 1)
      : Math.max(0, index - 1);
    const target = flat[next];
    if (!target) return;
    onselect(target.id);
    queueMicrotask(() => document.getElementById(`chat-${target.id}`)?.querySelector("button")?.focus());
  }
</script>

<div class="flex h-full min-h-0 flex-col border-r border-border bg-card">
  <header class="px-3 pb-2 pt-3">
    <div class="flex items-center gap-1 pl-1.5">
      <div class="min-w-0 flex-1">
        <h1 class="text-lg font-bold leading-tight">Agents</h1>
        <p class="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full {portal.connected ? 'bg-success' : 'bg-warning'}"
            aria-hidden="true"
          ></span>
          <span class="truncate">{portal.user?.display_name} · {portal.connected ? "Live" : "Reconnecting…"}</span>
        </p>
      </div>

      <button
        type="button"
        class="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition hover:bg-muted
             hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring
               disabled:opacity-40"
        onclick={toggleNotify}
        disabled={permission === "denied" || permission === "unsupported"}
        aria-pressed={portal.prefs.notify}
        aria-label={bellLabel}
        title={bellLabel}
      >
        {#if portal.prefs.notify}<BellIcon class="h-4 w-4" />{:else}<BellOffIcon class="h-4 w-4" />{/if}
      </button>

      <button
        type="button"
        class="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition hover:bg-muted
             hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onclick={portal.markAllRead}
        aria-label="Mark everything read"
        title="Mark everything read"
      ><CheckCheckIcon class="h-4 w-4" /></button>

      <button
        type="button"
        class="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition hover:bg-muted
             hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onclick={() => void portal.logout()}
        aria-label="Log out"
        title="Log out"
      ><LogOutIcon class="h-4 w-4" /></button>
    </div>

    <label class="relative mt-2 block">
      <span class="sr-only">Search agents</span>
      <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        bind:value={query}
        placeholder="Search"
        class="h-8 w-full rounded-lg border-0 bg-muted pl-8 pr-2 text-caption outline-none
               placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/30"
      />
    </label>
  </header>

  <nav class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" aria-label="Agent sessions">
    {#if query.trim() && flat.length === 0}
      <p class="px-3 py-6 text-center text-caption text-muted-foreground">No agents match “{query.trim()}”.</p>
    {/if}
    <ul>
      {#each live as agent (agent.id)}
        {@render row(agent)}
      {/each}
    </ul>

    {#if ended.length}
      <button
        type="button"
        class="mt-2 flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-[11px] font-semibold
               text-muted-foreground hover:text-foreground focus:outline-none
               focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-expanded={endedShown}
        onclick={() => portal.setPrefs({ endedOpen: !portal.prefs.endedOpen })}
      >
        <span class="transition-transform {endedShown ? 'rotate-90' : ''}" aria-hidden="true">›</span>
        {GROUP_LABEL.ended} ({ended.length})
      </button>
      {#if endedShown}
        <ul>
          {#each ended as agent (agent.id)}
            {@render row(agent)}
          {/each}
        </ul>
      {/if}
    {/if}
  </nav>
</div>

{#snippet row(agent: (typeof portal.agents)[number])}
  <li id="chat-{agent.id}">
    <ChatListItem
      {agent}
      selected={agent.id === portal.selectedId}
      now={portal.now}
      readRecord={portal.readRecord}
      unreadCount={portal.unreadCounts[agent.id]}
      {onselect}
      onkeydown={onKeydown}
    />
  </li>
{/snippet}
