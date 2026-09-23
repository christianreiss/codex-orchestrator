<script lang="ts">
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import InfoIcon from "@lucide/svelte/icons/info";
  import XIcon from "@lucide/svelte/icons/x";
  import type { Agent } from "$lib/portal/types";
  import { presenceView } from "$lib/portal/presence";
  import { clockTime, shortAge, shortPath } from "$lib/portal/browser";
  import EngineAvatar from "$lib/components/portal/EngineAvatar.svelte";

  let {
    agent,
    now,
    onback,
    onclose,
    onreconnect,
    heading = $bindable(null),
  }: {
    agent: Agent;
    now: number;
    onback: () => void;
    onclose: () => void;
    onreconnect?: () => void;
    heading?: HTMLHeadingElement | null;
  } = $props();

  const view = $derived(presenceView(agent, now));
  const tone = $derived(
    view.presence === "listening" || view.presence === "working" ? "text-success"
    : view.presence === "idle" ? "text-warning-muted-foreground"
    : "text-muted-foreground",
  );
  let infoOpen = $state(false);
  const detail = $derived(
    view.presence === "offline"
      ? `Last heartbeat ${clockTime(agent.heartbeat_at)} (${shortAge(agent.heartbeat_at, now)} ago)`
      : view.detail,
  );
</script>

<!--
  Messages-style header: back on the left, the conversation centred, actions on
  the right. Everything that used to stack underneath (heartbeat detail,
  receiver evidence) lives behind the info button.
-->
<header class="grid grid-cols-[4.5rem_1fr_4.5rem] items-center border-b border-border bg-card/95 px-2 py-1.5 backdrop-blur">
  <div class="flex items-center">
    <button
      type="button"
      class="grid h-9 w-9 place-items-center rounded-full text-primary transition hover:bg-muted
             focus:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
      onclick={onback}
      aria-label="Back to all agents"
    ><ChevronLeftIcon class="h-6 w-6" /></button>
  </div>

  <div class="flex min-w-0 flex-col items-center">
    <EngineAvatar engine={agent.engine} presence={view.presence} size="xs" badge />
    <h2 bind:this={heading} tabindex="-1" class="mt-0.5 max-w-full truncate text-caption font-semibold focus:outline-none">
      {agent.engine === "codex" ? "Codex" : "Claude"} · {agent.host}
    </h2>
    <p class="max-w-full truncate text-[11px] text-muted-foreground" title={agent.cwd}>
      <!-- The detail rides along whenever it says more than "listening". -->
      <span class="font-medium {tone}">{view.label}</span>{" · "}{#if view.presence === "listening"}{shortPath(agent.cwd)}{:else}<span title={detail}>{detail}</span>{/if}
    </p>
  </div>

  <div class="flex items-center justify-end">
    <button
      type="button"
      class="grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring {infoOpen ? 'text-primary' : 'hover:text-foreground'}"
      onclick={() => (infoOpen = !infoOpen)}
      aria-expanded={infoOpen}
      aria-controls="thread-info"
      aria-label="Session details"
      title="Session details"
    ><InfoIcon class="h-[1.1rem] w-[1.1rem]" /></button>
    {#if view.presence !== "ended"}
      <button
        type="button"
        class="grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-destructive"
        onclick={onclose}
        aria-label="Close this channel"
        title="Close this channel"
      ><XIcon class="h-4 w-4" /></button>
    {/if}
  </div>
</header>

{#if infoOpen}
  <div id="thread-info" class="space-y-1 border-b border-border bg-card px-4 py-2 text-[11px] text-muted-foreground">
    <p><strong class="font-semibold text-foreground">{view.label}.</strong> {detail}</p>
    <p class="truncate" title={agent.cwd}>{agent.username}@{agent.host} · {agent.cwd}</p>
    {#if agent.receiver}
      <details>
        <summary class="cursor-pointer">Reception: {agent.receiver.state}</summary>
        <p class="mt-1">{agent.receiver.protocol} · Native session {agent.receiver.native_session_id}</p>
        <p>Last receiver response: {clockTime(agent.receiver.heartbeat_at)}</p>
        {#each agent.receiver.sources as source}
          <p>{source.source}: {source.state} · transport health</p>
        {/each}
        {#if agent.receiver.failure}<p>{agent.receiver.failure}</p>{/if}
        {#if onreconnect && !agent.read_only && !agent.ended_at}
          <button type="button" class="my-1 rounded-full border border-border px-2.5 py-0.5 text-foreground hover:bg-muted" onclick={onreconnect}>Reconnect receiver</button>
        {/if}
      </details>
    {/if}
  </div>
{/if}
