<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { get } from 'svelte/store';
  import { api } from '$lib/api/client';
  import { authStore } from '$lib/stores/auth';
  import { type ScopeRoom, type ResourceClaim, type RoomHistory, type RoomEvent } from '$lib/api/coordination';
  import { Button } from '$lib/components/ui/button';
  let { room, claims, onclose }: { room: ScopeRoom; claims: ResourceClaim[]; onclose: () => void } = $props();
  const client = useQueryClient();
  const canRead = $derived($authStore.can('agent_messaging.reveal_content'));
  const canWrite = $derived($authStore.can('agent_messaging.manage'));
  // Parent keys this component by room ID, so a selection owns its query and draft.
  const history = createQuery<RoomHistory>({ queryKey: ['agent-scopes', 'history', room.id], queryFn: () => api.post('/admin/agent-messaging/scopes/read', { scope_id: room.id }), enabled: get(authStore).can('agent_messaging.reveal_content') });
  let draft = $state('');
  let pending = $state<{ content: string; id: string } | null>(null);
  let older = $state<RoomEvent[]>([]);
  let before = $state<number | null | undefined>(undefined);
  let reason = $state('');
  const events = $derived([...new Map([...older, ...($history.data?.events ?? [])].map(e => [e.id, e])).values()].sort((a,b) => a.sequence - b.sequence));
  const roomClaims = $derived(claims.filter(c => c.scope_ids?.includes(room.id) || room.members.some(m => m.session_id === c.session_id)));
  const send = createMutation({ mutationFn: () => {
    if (!pending || pending.content !== draft) pending = { content: draft, id: crypto.randomUUID() };
    return api.post('/admin/agent-messaging/scopes/send', { scope_id: room.id, content: pending.content, client_request_id: pending.id });
  }, onSuccess: async () => { draft = ''; pending = null; await client.invalidateQueries({ queryKey: ['agent-scopes'] }); } });
  const more = createMutation({ mutationFn: async () => {
    const cursor = before === undefined ? $history.data?.next_before : before;
    if (!cursor) return;
    const page = await client.fetchQuery<RoomHistory>({ queryKey: ['agent-scopes', 'history', room.id, cursor], queryFn: () => api.post('/admin/agent-messaging/scopes/read', { scope_id: room.id, before: cursor }) });
    older = [...page.events, ...older]; before = page.next_before;
  } });
  const resolve = createMutation({ mutationFn: (claimId: string) => api.post('/admin/agent-messaging/scopes/resolve', { claim_id: claimId, outcome: 'completed', reason }), onSuccess: async () => { reason = ''; await client.invalidateQueries({ queryKey: ['agent-scopes'] }); } });
</script>
<section class="flex h-full min-h-0 flex-col rounded-md border bg-card" aria-label={`${room.title} scope chat`}>
  <div class="flex items-center justify-between border-b p-3"><div><h3 class="font-medium">{room.title}</h3><p class="text-caption text-muted-foreground">{room.kind} · {room.member_count} members</p></div><Button variant="ghost" size="sm" onclick={onclose}>Close</Button></div>
  <details class="border-b p-3"><summary>Members and claims</summary>
    <ul class="my-2 space-y-1">{#each room.members as member (member.session_id)}<li class="text-caption">{member.name ?? member.session_id} · {member.engine} · {member.host} · {member.workspace?.branch ?? member.cwd}{member.coordinated ? '' : ' · limited coordination'}</li>{/each}</ul>
    {#each roomClaims as claim (claim.id)}<div class="my-2 rounded border p-2 text-caption"><strong>{claim.state}</strong> · {claim.purpose}<pre class="overflow-auto whitespace-pre-wrap">{JSON.stringify(claim.resources, null, 2)}</pre>
      {#if claim.isolation_available}<p>Git isolation available after unanswered coordination.</p>{/if}
      {#if claim.state === 'uncertain' && canWrite}<label class="block">Evidence that the operation ended<input class="my-1 w-full rounded border bg-background p-2" bind:value={reason} /></label><Button size="sm" disabled={!reason.trim() || $resolve.isPending} onclick={() => $resolve.mutate(claim.id)}>Resolve resource</Button>{/if}</div>{/each}
    {#if $resolve.error}<p role="alert" class="text-destructive">{$resolve.error.message}</p>{/if}
  </details>
  <div class="min-h-0 flex-1 space-y-3 overflow-auto p-3" aria-live="polite">
    {#if !canRead}<p>Content reveal permission is required to read this room.</p>
    {:else if $history.isPending}<p>Loading conversation…</p>
    {:else if $history.error}<p role="alert" class="text-destructive">{$history.error.message}</p><Button onclick={() => $history.refetch()}>Retry</Button>
    {:else}
      {#if (before === undefined ? $history.data?.next_before : before)}<Button variant="outline" size="sm" disabled={$more.isPending} onclick={() => $more.mutate()}>Earlier messages</Button>{/if}
      {#if $more.error}<p role="alert">{$more.error.message}</p>{/if}
      {#each events as event (event.id)}<article class={event.kind === 'chat' ? 'rounded-md bg-muted p-3' : 'text-caption text-muted-foreground'}><div class="text-caption">{event.body.name ?? event.actor} · {new Date(event.created_at).toLocaleTimeString()}</div><p class="whitespace-pre-wrap break-words">{event.body.content ?? [event.body.action, event.body.purpose, event.body.reason].filter(Boolean).join(' · ')}</p></article>{/each}
      {#if !events.length}<p class="text-muted-foreground">No messages yet.</p>{/if}
    {/if}
  </div>
  {#if canWrite}<form class="space-y-2 border-t p-3" onsubmit={e => { e.preventDefault(); $send.mutate(); }}><label for="scope-message" class="text-caption">Message all active members</label><textarea id="scope-message" class="w-full rounded-md border bg-background p-2" rows="3" maxlength="30000" bind:value={draft} disabled={$send.isPending}></textarea><Button type="submit" disabled={!draft.trim() || $send.isPending}>Send as operator</Button>{#if $send.error}<p role="alert" class="text-destructive">{$send.error.message}</p>{/if}</form>{/if}
</section>
