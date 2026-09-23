<script lang="ts">
  import type { Agent } from "$lib/portal/types";
  import { presenceView } from "$lib/portal/presence";
  import { unreadBadge } from "$lib/portal/unread";
  import type { ReadRecord } from "$lib/portal/unread";
  import { listTime } from "$lib/portal/grouping";
  import { clockTime, shortAge, shortPath } from "$lib/portal/browser";
  import ConversationRow from "$lib/components/portal/ConversationRow.svelte";

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

  // Attention outranks presence: an agent that went offline while waiting on an
  // answer still needs you, so the row must not be greyed out.
  const needsYou = $derived(!agent.ended_at && agent.presence !== "ended" && Boolean(agent.attention || agent.pending_prompt));

  const subtitle = $derived.by(() => {
    if (needsYou) {
      const ask = agent.pending_prompt?.question ?? agent.attention?.summary ?? "Waiting for you";
      return `${ask} · ${shortAge(agent.pending_prompt?.created_at ?? agent.attention!.since, now)}`;
    }
    if (view.presence === "offline") return `Offline · last beat ${shortAge(agent.heartbeat_at, now)} ago`;
    if (view.presence === "ended") return `Ended ${agent.ended_at ? clockTime(agent.ended_at) : ""}`.trim();
    if (view.presence === "idle") return view.detail;
    return shortPath(agent.cwd);
  });
</script>

<ConversationRow
  engine={agent.engine}
  presence={view.presence}
  title={agent.host}
  time={listTime(agent.last_event_at ?? agent.started_at, new Date(now))}
  preview={subtitle}
  {selected}
  {needsYou}
  {badge}
  aria-current={selected ? "true" : undefined}
  tabindex={selected ? 0 : -1}
  onclick={() => onselect(agent.id)}
  {onkeydown}
/>
