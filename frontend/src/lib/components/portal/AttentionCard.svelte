<script lang="ts">
  import type { Agent, PresenceTimings } from '$lib/portal/types';
  import { presenceView } from '$lib/portal/presence';
  import AttachmentList from './AttachmentList.svelte';
  import { api } from '$lib/api/client';
  let { agent, now, onreply, onresolved, readonly = false, busy = false, timings }: {agent:Agent;now:number;onreply:(option?:string)=>void;onresolved?:()=>void;readonly?:boolean;busy?:boolean;timings?:PresenceTimings} = $props();
  const prompt = $derived(agent.pending_prompt);
  const notices = $derived(agent.notices ?? (agent.attention?.id ? [agent.attention] : []));
  const choices = $derived(prompt?.choices?.length ? prompt.choices : (prompt?.options ?? []).map(value => ({label:value,value})));
  const canReply = $derived(!readonly && presenceView(agent,now,timings).canSend);
  let error = $state('');
  let resolving = $state<string | null>(null);
  const operationIds = new Map<string,string>();
  async function resolve(id:string) {
    resolving = id;
    const key = operationIds.get(id) ?? crypto.randomUUID(); operationIds.set(id,key);
    try { await api.post(`/admin/agent-sessions/${agent.id}/notices/resolve`,{notice_id:id,client_event_id:key}); error=''; onresolved?.(); }
    catch(e) { error=e instanceof Error ? e.message : 'Resolution failed'; }
    finally { resolving=null; }
  }
</script>
{#if notices.length || agent.attention || prompt}
  <section aria-label={notices.length || agent.attention || (prompt && !prompt.answer_mode) ? 'Needs you' : 'Your answer'} class="max-h-64 shrink-0 overflow-y-auto border-t px-4 py-2">
    {#each notices as notice (notice.id)}
      <div class="mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive-muted p-2">
        <div class="min-w-0 flex-1"><p class="text-xs font-semibold">Needs you · {notice.severity}</p><p class="text-sm">{notice.summary}</p></div>
        {#if !readonly && notice.id}<button type="button" class="rounded border px-2 py-1 text-xs" disabled={resolving !== null} onclick={() => resolve(notice.id!)}>Mark resolved</button>{/if}
      </div>
    {/each}
    {#if !notices.length && agent.attention}<p class="text-sm">Needs you · {agent.attention.summary}</p>{#if canReply}<button type="button" class="text-xs underline" onclick={() => onreply()}>Reply</button>{/if}{/if}
    {#if prompt}
      <p class="text-xs font-semibold">Your answer</p><p class="text-sm">{prompt.question}</p>
      {#if prompt.attachments?.length}<AttachmentList session={agent.id} ids={prompt.attachments} />{/if}
      {#if prompt.answer_mode !== 'text'}<div class="mt-2 flex flex-wrap gap-2">{#each choices as choice (choice.value)}<button type="button" class="rounded-full border border-primary/40 px-3 py-1 text-xs text-primary" disabled={!canReply || busy} onclick={() => onreply(choice.value)}>{choice.label}</button>{/each}</div>{/if}
      {#if prompt.answer_mode !== 'buttons' && canReply}<button type="button" class="mt-2 text-xs underline" onclick={() => onreply()}>Write an answer</button>{/if}
      {#if !canReply}<p class="mt-1 text-xs text-muted-foreground">Agent currently unavailable for answers.</p>{/if}
    {/if}
    {#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
  </section>
{/if}
