<script lang="ts">
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import XIcon from "@lucide/svelte/icons/x";
  import type { Agent } from "$lib/portal/types";
  import { presenceView } from "$lib/portal/presence";
  import { clockTime, shortAge, shortPath } from "../../lib/browser";
  import EngineAvatar from "../shell/EngineAvatar.svelte";
  import PresenceDot from "../shell/PresenceDot.svelte";

  let {
    agent,
    now,
    onback,
    onclose,
    heading = $bindable(null),
  }: {
    agent: Agent;
    now: number;
    onback: () => void;
    onclose: () => void;
    heading?: HTMLHeadingElement | null;
  } = $props();

  const view = $derived(presenceView(agent, now));
  const tone = $derived(
    view.presence === "listening" ? "border-success/30 bg-success-muted text-success-muted-foreground"
    : view.presence === "idle" ? "border-warning/30 bg-warning-muted text-warning-muted-foreground"
    : "border-border bg-muted text-muted-foreground",
  );
  const detail = $derived(
    view.presence === "offline"
      ? `Last heartbeat ${clockTime(agent.heartbeat_at)} (${shortAge(agent.heartbeat_at, now)} ago)`
      : view.detail,
  );
</script>

<header class="flex items-start gap-3 border-b border-border bg-card px-3 py-2.5 sm:px-4">
  <button
    type="button"
    class="-ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground transition
           hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2
           focus-visible:ring-ring md:hidden"
    onclick={onback}
    aria-label="Back to all agents"
  ><ChevronLeftIcon class="h-5 w-5" /></button>

  <EngineAvatar engine={agent.engine} presence={view.presence} size="sm" />

  <div class="min-w-0 flex-1">
    <h2 bind:this={heading} tabindex="-1" class="truncate text-body font-semibold focus:outline-none">
      {agent.engine === "codex" ? "Codex" : "Claude"} · {agent.host}
    </h2>
    <p class="truncate text-[11px] text-muted-foreground" title={agent.cwd}>
      {agent.username}@{agent.host} · {shortPath(agent.cwd)}
    </p>
  </div>

  <div class="flex shrink-0 items-center gap-2">
    <span class="hidden items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium sm:inline-flex {tone}">
      <PresenceDot presence={view.presence} />
      {view.label}
    </span>
    {#if view.presence !== "ended"}
      <button
        type="button"
        class="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition hover:bg-muted
               hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onclick={onclose}
        aria-label="Close this channel"
        title="Close this channel"
      ><XIcon class="h-4 w-4" /></button>
    {/if}
  </div>
</header>

<p class="border-b border-border bg-card px-3 pb-2 text-[11px] text-muted-foreground sm:px-4">
  <span class="sm:hidden"><strong class="font-semibold">{view.label}.</strong> </span>{detail}
</p>
