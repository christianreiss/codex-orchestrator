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
  <section aria-label="Needs you" class="max-h-44 shrink-0 overflow-y-auto border-t border-destructive/20 bg-destructive-muted/60 px-3 py-2 sm:px-4">
    <div class="mx-auto flex max-w-3xl items-start gap-2 text-destructive-muted-foreground">
      <AlertTriangleIcon class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="flex items-baseline gap-2">
          <span class="text-caption font-semibold">Needs you</span>
          {#if since}<span class="text-[11px] opacity-80">waiting {shortAge(since, now)}</span>{/if}
        </p>
        {#if summary && summary !== prompt?.question}<p class="line-clamp-3 whitespace-pre-wrap text-caption" title={summary}>{summary}</p>{/if}
        {#if prompt}
          <p class="line-clamp-3 whitespace-pre-wrap text-caption font-medium" title={prompt.question}>{prompt.question}</p>
        {:else if !summary}
          <p class="text-caption">The agent is waiting for your response.</p>
        {/if}
      </div>
      {#if canReply}
        <button type="button" class="shrink-0 rounded-full bg-destructive px-3 py-1 text-[11px] font-semibold text-destructive-foreground transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onclick={() => onreply()}>{prompt ? "Write an answer" : "Reply"}</button>
      {/if}
    </div>
    {#if prompt && canReply && prompt.options.length}
      <!-- Quick replies: tapping one sends it as the answer. -->
      <div class="mx-auto mt-1.5 flex max-w-3xl flex-wrap gap-1.5 pl-6">
        {#each prompt.options as option (option)}
          <button type="button" class="rounded-full border border-primary/40 bg-background px-3 py-1 text-caption font-medium text-primary transition hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onclick={() => onreply(option)}>{option}</button>
        {/each}
      </div>
    {/if}
  </section>
{/if}
