<script lang="ts">
  import type { Agent } from "$lib/portal/types";
  import { presenceView } from "$lib/portal/presence";
  import { unreadBadge } from "$lib/portal/unread";
  import type { ReadRecord } from "$lib/portal/unread";
  import { clockTime, shortAge, shortPath } from "../../lib/browser";
  import EngineAvatar from "./EngineAvatar.svelte";
  import PresenceDot from "./PresenceDot.svelte";

  let {
    agent,
    selected,
    now,
    readRecord,
    unreadCount,
    onselect,
    onkeydown,
  }: {
    agent: Agent;
    selected: boolean;
    now: number;
    readRecord: ReadRecord;
    unreadCount: number | undefined;
    onselect: (id: string) => void;
    onkeydown: (event: KeyboardEvent) => void;
  } = $props();

  const view = $derived(presenceView(agent, now));
  const badge = $derived(unreadBadge(agent, readRecord, unreadCount));
  const dim = $derived(view.presence === "offline" || view.presence === "ended");

  // Attention outranks presence: an agent that went offline while waiting on an
  // answer still needs you, so the row must not be greyed out.
  const needsYou = $derived(Boolean(agent.attention));

  const subtitle = $derived.by(() => {
    if (agent.attention) return agent.attention.summary ?? "Waiting for you";
    if (view.presence === "offline") return `Offline · last beat ${shortAge(agent.heartbeat_at, now)} ago`;
    if (view.presence === "ended") return `Ended ${agent.ended_at ? clockTime(agent.ended_at) : ""}`.trim();
    if (view.presence === "idle") return view.detail;
    return shortPath(agent.cwd);
  });
</script>

<button
  type="button"
  class="relative flex w-full items-start gap-3 py-2.5 pl-4 pr-3 text-left transition hover:bg-muted/60
         focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring
         {selected ? 'bg-muted' : ''}
         {needsYou ? 'bg-destructive-muted hover:bg-destructive-muted' : ''}
         {dim && !needsYou ? 'opacity-70' : ''}"
  aria-current={selected ? "true" : undefined}
  tabindex={selected ? 0 : -1}
  onclick={() => onselect(agent.id)}
  {onkeydown}
>
  <!-- Left rail: attention wins over selection. -->
  <span
    class="absolute inset-y-0 left-0 w-[3px] {needsYou ? 'bg-destructive' : selected ? 'bg-primary' : 'bg-transparent'}"
    aria-hidden="true"
  ></span>

  <EngineAvatar engine={agent.engine} presence={view.presence} />

  <span class="min-w-0 flex-1">
    <span class="flex items-center gap-1.5">
      <PresenceDot presence={view.presence} />
      <span class="truncate text-body font-medium {dim && !needsYou ? 'text-muted-foreground' : ''}">
        {agent.host}
      </span>
      <span class="ml-auto shrink-0 text-[11px] text-muted-foreground">
        {agent.last_event_at ? clockTime(agent.last_event_at) : ""}
      </span>
    </span>
    <span
      class="mt-0.5 line-clamp-2 block text-caption
             {needsYou ? 'font-medium text-destructive-muted-foreground' : 'text-muted-foreground'}"
    >{subtitle}</span>
    {#if agent.attention}
      <span class="mt-0.5 block text-[11px] text-destructive-muted-foreground">
        waiting {shortAge(agent.attention.since, now)}
      </span>
    {/if}
  </span>

  {#if badge?.kind === "attention"}
    <span
      class="mt-1 grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-destructive px-1
             text-[11px] font-bold text-destructive-foreground"
    >!<span class="sr-only">needs you</span></span>
  {:else if badge?.kind === "count"}
    <span
      class="mt-1 grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1.5
             text-[11px] font-semibold text-primary-foreground"
    >{badge.value > 99 ? "99+" : badge.value}<span class="sr-only">unread</span></span>
  {:else if badge?.kind === "dot"}
    <span class="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread"></span>
  {/if}
</button>
