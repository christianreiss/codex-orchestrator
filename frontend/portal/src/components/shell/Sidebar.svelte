<script lang="ts">
  import BellIcon from "@lucide/svelte/icons/bell";
  import BellOffIcon from "@lucide/svelte/icons/bell-off";
  import CheckCheckIcon from "@lucide/svelte/icons/check-check";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import { GROUP_LABEL, groupAgents } from "$lib/portal/presence";
  import type { Portal } from "../../lib/portal-state.svelte";
  import {
    notificationPermission,
    requestNotificationPermission,
    setNotifyBrokenHandler,
  } from "../../lib/browser";
  import ChatListItem from "./ChatListItem.svelte";

  let { portal, onselect }: { portal: Portal; onselect: (id: string) => void } = $props();

  const groups = $derived(groupAgents(portal.agents, portal.now));
  const flat = $derived(groups.flatMap((group) => (group.key === "ended" && !portal.prefs.endedOpen ? [] : group.agents)));
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
  <header class="flex items-center gap-2 border-b border-border px-4 py-3">
    <div class="min-w-0 flex-1">
      <p class="truncate text-body font-semibold">{portal.user?.display_name}</p>
      <p class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span
          class="h-1.5 w-1.5 rounded-full {portal.connected ? 'bg-success' : 'bg-warning'}"
          aria-hidden="true"
        ></span>
        {portal.connected ? "Live" : "Reconnecting…"}
      </p>
    </div>

    <button
      type="button"
      class="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-muted
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
      class="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-muted
             hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onclick={portal.markAllRead}
      aria-label="Mark everything read"
      title="Mark everything read"
    ><CheckCheckIcon class="h-4 w-4" /></button>

    <button
      type="button"
      class="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-muted
             hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onclick={() => void portal.logout()}
      aria-label="Log out"
      title="Log out"
    ><LogOutIcon class="h-4 w-4" /></button>
  </header>

  <nav class="min-h-0 flex-1 overflow-y-auto" aria-label="Agent sessions">
    <ul>
      {#each groups as group (group.key)}
        <li>
          {#if group.key === "ended"}
            <button
              type="button"
              class="flex w-full items-center gap-1.5 px-4 py-2 text-left text-[11px] font-semibold uppercase
                     tracking-[0.08em] text-muted-foreground hover:text-foreground focus:outline-none
                     focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-expanded={portal.prefs.endedOpen}
              onclick={() => portal.setPrefs({ endedOpen: !portal.prefs.endedOpen })}
            >
              <span class="transition-transform {portal.prefs.endedOpen ? 'rotate-90' : ''}" aria-hidden="true">›</span>
              {GROUP_LABEL[group.key]} ({group.agents.length})
            </button>
          {:else}
            <p
              class="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em]
                     {group.key === 'attention' ? 'text-destructive' : 'text-muted-foreground'}"
            >
              {GROUP_LABEL[group.key]}{group.key === "attention" ? ` (${group.agents.length})` : ""}
            </p>
          {/if}

          {#if group.key !== "ended" || portal.prefs.endedOpen}
            <ul>
              {#each group.agents as agent (agent.id)}
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
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  </nav>
</div>
