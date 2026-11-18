<script lang="ts">
  import type { Agent, PresenceTimings } from '$lib/portal/types';
  import { presenceView } from '$lib/portal/presence';
  import AttachmentList from './AttachmentList.svelte';
  let { agent, now, onreply, readonly = false, busy = false, timings }: {agent:Agent;now:number;onreply:(option?:string)=>void;readonly?:boolean;busy?:boolean;timings?:PresenceTimings} = $props();
  const prompt = $derived(agent.pending_prompt);
  const attention = $derived(agent.attention?.severity ? null : agent.attention);
  const choices = $derived(prompt?.choices?.length ? prompt.choices : (prompt?.options ?? []).map(value => ({label:value,value})));
  const canReply = $derived(!readonly && presenceView(agent,now,timings).canSend);
</script>
{#if attention || prompt}
  <section aria-label={attention || (prompt && !prompt.answer_mode) ? 'Needs you' : 'Your answer'} class="max-h-64 shrink-0 overflow-y-auto border-t px-4 py-2">
    {#if attention}<p class="text-body-sm">Needs you · {attention.summary}</p>{#if canReply}<button type="button" class="text-caption underline" onclick={() => onreply()}>Reply</button>{/if}{/if}
    {#if prompt}
      <p class="text-caption font-semibold">Your answer</p><p class="text-body-sm">{prompt.question}</p>
      {#if prompt.attachments?.length}<AttachmentList session={agent.id} ids={prompt.attachments} />{/if}
      {#if prompt.answer_mode !== 'text'}<div class="mt-2 flex flex-wrap gap-2">{#each choices as choice (choice.value)}<button type="button" class="rounded-full border border-primary/40 px-3 py-1 text-caption text-primary" disabled={!canReply || busy} onclick={() => onreply(choice.value)}>{choice.label}</button>{/each}</div>{/if}
      {#if prompt.answer_mode !== 'buttons' && canReply}<button type="button" class="mt-2 text-caption underline" onclick={() => onreply()}>Write an answer</button>{/if}
      {#if !canReply}<p class="mt-1 text-caption text-muted-foreground">Agent currently unavailable for answers.</p>{/if}
    {/if}
  </section>
{/if}
