<script lang="ts">
  import AlertTriangleIcon from "@lucide/svelte/icons/triangle-alert";
  import type { Agent, PresenceTimings } from "$lib/portal/types";
  import { presenceView } from "$lib/portal/presence";
  import { shortAge } from "$lib/portal/browser";

  let { agent, now, onreply, readonly = false, busy = false, timings }: {
    agent: Agent;
    now: number;
    onreply: (option?: string) => void;
    readonly?: boolean;
    busy?: boolean;
    timings?: PresenceTimings;
  } = $props();

  const needed = $derived(!agent.ended_at && agent.presence !== "ended" && Boolean(agent.attention || agent.pending_prompt));
  const prompt = $derived(agent.pending_prompt);
  const summary = $derived(agent.attention?.summary);
  const since = $derived(prompt?.created_at ?? agent.attention?.since);
  const canReply = $derived(!readonly && presenceView(agent, now, timings).canSend);
</script>

{#if needed}
  <section aria-label="Needs you" class="max-h-44 shrink-0 overflow-y-auto border-t border-destructive/25 border-l-4 border-l-destructive bg-destructive-muted px-4 py-3">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-destructive-muted-foreground">
      <AlertTriangleIcon class="h-5 w-5 shrink-0" aria-hidden="true" />
      <h3 class="text-sm font-semibold">Needs you</h3>
      {#if since}<span class="text-[11px] opacity-80">Waiting {shortAge(since, now)}</span>{/if}
      {#if canReply}
        <button type="button" class="ml-auto rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onclick={() => onreply()}>{prompt ? "Write an answer" : "Reply"}</button>
      {/if}
    </div>
    {#if summary && summary !== prompt?.question}<p class="mt-2 whitespace-pre-wrap text-sm text-destructive-muted-foreground">{summary}</p>{/if}
    {#if prompt}
      <p class="mt-2 whitespace-pre-wrap text-sm font-medium text-destructive-muted-foreground">{prompt.question}</p>
      {#if canReply && prompt.options.length}
        <div class="mt-2 flex flex-wrap gap-2">
          {#each prompt.options as option (option)}
            <button type="button" class="rounded-md border border-destructive/25 bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onclick={() => onreply(option)}>{option}</button>
          {/each}
        </div>
      {/if}
    {:else if !summary}
      <p class="mt-2 text-sm text-destructive-muted-foreground">The agent is waiting for your response.</p>
    {/if}
  </section>
{/if}
