<script lang="ts">
  import { toStore } from 'svelte/store';
  import { onMount, tick, untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { Dialog } from 'bits-ui';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { authStore } from '$lib/stores/auth';
  import { engineLabel } from '$lib/constants/engines';
  import { api } from '$lib/api/client';
  import { chattyKeys, fetchChattyStatus, fetchChattySession, chattyContext, type ChattyElement, type ChattyEvent, type Engine } from '$lib/api/chatty';
  import MarkdownBody from '$lib/components/portal/MarkdownBody.svelte';
  import { Button } from '$lib/components/ui/button';
  import { chattyPath, isPlainClick, latestAnswerId } from './elements';
  import { actionPath, chattyAction, isExpired, type ChattyActionElement } from './actions';
  import ChattyActionDialog from './ChattyActionDialog.svelte';
  import { ArrowRight, BookOpen, Check, CircleAlert, FolderKanban, Library, ListFilter, MessageSquarePlus, Minus, Play, Send, Server, Square, Trash2, TriangleAlert, UserRoundCog, Waypoints } from '@lucide/svelte';

  const qc = useQueryClient();
  let open = $state(false);
  let draft = $state('');
  let busy = $state(false);
  let draftRevision = 0;
  let error = $state('');
  let older = $state<ChattyEvent[]>([]);
  let olderGeneration = $state(0);
  let input = $state<HTMLTextAreaElement>();
  let bottom = $state<HTMLDivElement>();
  let timeline = $state<HTMLDivElement>();
  let followingLatest = $state(true);
  let unreadOutput = $state(false);
  function followLatest() { followingLatest = true; unreadOutput = false; bottom?.scrollIntoView({ block: 'end', behavior: 'instant' }); }
  function trackReading() { if (timeline) followingLatest = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 64; if (followingLatest) unreadOutput = false; }
  let retryMessage = $state<{ id: string; text: string; generation: number; context: ReturnType<typeof chattyContext> } | null>(null);
  const status = createQuery(toStore(() => ({ queryKey: [...chattyKeys.status, $authStore.user?.id], queryFn: fetchChattyStatus, enabled: $authStore.can('chatty.use'), retry: false })));
  const session = createQuery(toStore(() => ({ queryKey: [...chattyKeys.session, $authStore.user?.id], queryFn: () => fetchChattySession(), enabled: open && $authStore.can('chatty.use'), retry: false })));
  const active = $derived($session.data?.active);
  const selectionLocked = $derived(busy || !!active || !$session.data);
  const selectedEngine = $derived($status.data?.engines.find(engine => engine.engine === $session.data?.selection.engine));
  const events = $derived([...($session.data?.generation === olderGeneration ? older : []), ...($session.data?.events ?? [])].filter((e, i, a) => a.findIndex(x => x.id === e.id) === i));
  const canSend = $derived(!!$status.data?.ready && !busy && (!active || active.status === 'waiting_input'));
  const pending = (event: ChattyEvent) => event.body.status === 'pending' && active?.status === 'waiting_confirmation' && active.id === event.runId && !events.some(e => e.kind === 'result' && e.body.id === event.body.id);
  const refresh = () => qc.invalidateQueries({ queryKey: chattyKeys.session });
  const latestAnswer = $derived(latestAnswerId(events));
  type LinkElement = Extract<ChattyElement, { type: 'link' }>;
  const links = (event: ChattyEvent) => (event.body.elements ?? []).filter((e): e is LinkElement => e?.type === 'link' && typeof e.label === 'string' && !!chattyPath(e.path));
  const suggestions = (event: ChattyEvent) => (event.body.elements ?? []).flatMap((e) => (e?.type === 'suggestion' && typeof e.text === 'string' && e.text.trim() ? [e.text] : []));
  const actions = (event: ChattyEvent) => (event.body.elements ?? []).flatMap((e) => { const action = chattyAction(e); return action && (action.risk !== 'safe' || actionPath(action)) ? [action] : []; });
  const riskIcons = { safe: ListFilter, confirm: Play, danger: TriangleAlert } as const;
  const riskHint = { safe: '', confirm: ' (asks for confirmation)', danger: ' (dangerous: you type the name to confirm)' } as const;
  /** Proposals expire server-side; the clock only greys out buttons that would be refused anyway. */
  let clock = $state(Date.now());
  let pendingAction = $state<ChattyActionElement | null>(null);
  let actionOpen = $state(false);
  let outcomes = $state<Record<string, { ok: boolean; text: string }>>({});
  function runAction(event: MouseEvent, action: ChattyActionElement) {
    const path = action.risk === 'safe' ? actionPath(action) : null;
    if (path) return void navigate(event, path);
    if (action.risk === 'safe' || isExpired(action)) return;
    pendingAction = action; actionOpen = true;
  }
  const linkIcons: Record<string, typeof ArrowRight> = { host: Server, project: FolderKanban, skill: Library, subagent: Library, command: Library, 'output-style': Library, workflow: Waypoints, workflow_run: Waypoints, account: UserRoundCog, manual: BookOpen };
  /** Client-side navigation keeps the shell, and with it this conversation; the full-screen phone panel minimizes so the destination is visible. */
  async function navigate(event: MouseEvent, path: string) {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    await goto(`${base}${path}`);
    if (window.matchMedia('(max-width: 767px)').matches) open = false;
  }
  async function operation(fn: () => Promise<unknown>) {
    busy = true; error = '';
    try { await fn(); await refresh(); } catch (e) { error = e instanceof Error ? e.message : 'Chatty could not finish the request.'; }
    finally { busy = false; }
  }
  async function send(suggestion?: string) {
    const fromComposer = suggestion === undefined;
    const text = suggestion ?? draft;
    const submittedRevision = draftRevision;
    if (!text.trim() || !canSend || !$session.data) return;
    const generation = $session.data.generation;
    await operation(async () => {
      if (active?.status === 'waiting_input') await api.post(`/admin/chatty/runs/${active.id}/answer`, { text, generation });
      else {
        if (!retryMessage || retryMessage.text !== text || retryMessage.generation !== generation) retryMessage = { id: crypto.randomUUID(), text, generation, context: chattyContext(page.url.pathname) };
        await api.post('/admin/chatty/messages', { client_message_id: retryMessage.id, generation, text, context: retryMessage.context });
      }
      retryMessage = null; if (fromComposer && draftRevision === submittedRevision && draft === text) draft = '';
    });
  }
  async function newChat() {
    if (busy) return;
    const resetRevision = draftRevision;
    await operation(async () => {
      await api.delete('/admin/chatty/session');
      older = []; olderGeneration = 0; if (draftRevision === resetRevision) draft = ''; retryMessage = null;
    });
    await tick();
    input?.focus();
  }
  async function select(engine: string, model: string | null = null) {
    if (selectionLocked) return;
    await operation(() => api.put('/admin/chatty/selection', { engine: (engine || null) as Engine | null, model }));
  }
  async function more() {
    await operation(async () => {
      const data = await fetchChattySession(events[0]?.id);
      olderGeneration = data.generation; older = [...data.events, ...events];
    });
  }
  $effect(() => {
    const count = $session.data?.events.length;
    if (open && count) {
      if (untrack(() => followingLatest)) void tick().then(followLatest);
      else unreadOutput = true;
    }
  });
  $effect(() => {
    if (!open) return;
    clock = Date.now();
    const timer = setInterval(() => { clock = Date.now(); }, 30_000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    if (!open || !$authStore.can('chatty.use')) return;
    const stream = new EventSource('/admin/chatty/events');
    stream.addEventListener('changed', () => { void refresh(); });
    stream.onopen = () => { void refresh(); };
    return () => stream.close();
  });
  onMount(() => {
    const show = () => { if ($authStore.can('chatty.use') && $status.data?.visible) open = true; };
    window.addEventListener('codex:open-chatty', show);
    return () => window.removeEventListener('codex:open-chatty', show);
  });
</script>

{#if $authStore.can('chatty.use') && $status.data?.visible}
  <Dialog.Root bind:open>
    <Dialog.Trigger class="chatty-launcher" aria-label="Open Chatty" title={$status.data.ready ? 'Chatty' : 'Chatty · no AI access available'}>
      <svg viewBox="0 0 48 48" aria-hidden="true" class:thinking={active?.status === 'running'}>
        <path d="M10 8h28a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H22l-9 6v-6h-3a5 5 0 0 1-5-5V13a5 5 0 0 1 5-5Z" fill="currentColor" />
        <g class="face" fill="var(--chatty-face, #142020)"><circle cx="17" cy="22" r="2.4"/><circle cx="31" cy="22" r="2.4"/></g><!-- slop-ok: Chatty mascot artwork -->
        <path d="M18 29q6 5 12 0" fill="none" stroke="var(--chatty-face, #142020)" stroke-width="2.4" stroke-linecap="round"/><!-- slop-ok: Chatty mascot artwork -->
      </svg>
      {#if !$status.data.ready}<span class="offline" aria-hidden="true"></span>{/if}
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Content class="chatty-panel" onOpenAutoFocus={(e) => { e.preventDefault(); void tick().then(() => input?.focus()); }} onInteractOutside={(e) => e.preventDefault()}>
        <div class="flex items-center justify-between border-b p-3">
          <div><Dialog.Title class="font-semibold">Chatty</Dialog.Title><Dialog.Description class="text-body-sm text-muted-foreground">Your assistant for the orchestrator</Dialog.Description></div>
          <div class="flex gap-1">
            <button class="icon-button" aria-label="New conversation" title="New conversation" disabled={busy} onclick={() => void newChat()}><Trash2 size={17}/></button>
            <Dialog.Close class="icon-button" aria-label="Minimize Chatty"><Minus size={19}/></Dialog.Close>
          </div>
        </div>
        <div class="min-w-0 shrink-0 space-y-1 border-b px-3 py-2">
          <div class="flex flex-wrap gap-1" role="group" aria-label="Chatty engine">
            <button type="button" class="selection-button" aria-pressed={!$session.data?.selection.engine} disabled={selectionLocked} onclick={() => void select('')}>Automatic</button>
            {#each $status.data.engines as engine (engine.engine)}
              <button type="button" class="selection-button inline-flex items-center gap-1.5" aria-pressed={$session.data?.selection.engine === engine.engine} disabled={selectionLocked}
                aria-label={`${engineLabel(engine.engine)}${engine.ready ? '' : ' · unavailable'}`}
                title={engine.ready ? undefined : engine.reason ?? 'Unavailable'} onclick={() => void select(engine.engine)}>
                {engineLabel(engine.engine)}{#if !engine.ready}<span class="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true"></span>{/if}
              </button>
            {/each}
          </div>
          {#if $session.data?.selection.engine}
            <div class="flex gap-1 overflow-x-auto py-1" role="group" aria-label="Chatty model">
              <button type="button" class="selection-button" aria-pressed={!$session.data.selection.model} disabled={selectionLocked} onclick={() => void select($session.data!.selection.engine!)}>Default model</button>
              {#each selectedEngine?.models ?? [] as model (model.id)}
                <button type="button" class="selection-button max-w-[16rem] truncate" title={model.display_name} aria-pressed={$session.data.selection.model === model.id} disabled={selectionLocked} onclick={() => void select($session.data!.selection.engine!, model.id)}>{model.display_name}</button>
              {/each}
            </div>
          {/if}
        </div>
        <div bind:this={timeline} onscroll={trackReading} class="min-h-0 flex-1 overflow-y-auto p-3" role="log" aria-label="Chatty conversation" aria-live="polite" aria-relevant="additions">
          {#if $session.data?.has_older}<button class="mb-3 text-body-sm underline" onclick={() => void more()} disabled={busy}>Load older messages</button>{/if}
          {#if !$session.isPending && events.length === 0}<p class="py-8 text-body text-muted-foreground">What do you want to know or change? I can explain the product, look up the current state and carry out admin tasks.</p>{/if}
          {#each events as event (event.id)}
            <article class="mb-3 rounded-md p-3 text-body {event.kind === 'user' ? 'ml-6 bg-primary/10' : 'bg-muted/60'}">
              {#if event.kind === 'user'}<p class="mb-1 text-body-sm font-semibold">You</p><p class="whitespace-pre-wrap">{event.body.text}</p>
              {:else if event.kind === 'answer' || event.kind === 'question'}
                <p class="mb-1 text-body-sm font-semibold">Chatty{event.body.engine ? ` · ${engineLabel(event.body.engine)}` : ''}{event.body.model ? ` · ${event.body.model}` : ''}</p>
                <MarkdownBody text={event.body.text ?? ''}/>
                {#if event.kind === 'answer'}
                  {@const eventLinks = links(event)}
                  {@const eventSuggestions = event.id === latestAnswer ? suggestions(event) : []}
                  {#if eventLinks.length}
                    <div class="mt-3 flex flex-wrap gap-2" role="group" aria-label="Links from Chatty's answer">
                      {#each eventLinks as link (link.path)}
                        {@const Icon = linkIcons[link.kind] ?? ArrowRight}
                        <Button href={`${base}${link.path}`} variant="outline" class="chatty-element max-w-full justify-start text-left" onclick={(e: MouseEvent) => void navigate(e, link.path)}>
                          <Icon size={16} aria-hidden="true" class="shrink-0"/><span class="min-w-0 break-words">{link.label}</span>
                        </Button>
                      {/each}
                    </div>
                  {/if}
                  {@const eventActions = actions(event)}
                  {#if eventActions.length}
                    <div class="mt-3 flex flex-wrap gap-2" role="group" aria-label="Actions from Chatty's answer">
                      {#each eventActions as action (action.proposal)}
                        {@const Icon = riskIcons[action.risk]}
                        {@const path = action.risk === 'safe' ? actionPath(action) : null}
                        {#if path}
                          <Button href={`${base}${path}`} variant="outline" class="chatty-element max-w-full justify-start text-left" onclick={(e: MouseEvent) => runAction(e, action)}>
                            <Icon size={16} aria-hidden="true" class="shrink-0"/><span class="min-w-0 break-words">{action.label}</span>
                          </Button>
                        {:else}
                          {@const expired = isExpired(action, clock)}
                          <Button variant="secondary" class="chatty-element max-w-full justify-start text-left {action.risk === 'danger' ? 'chatty-action-danger' : ''}" disabled={expired} onclick={(e: MouseEvent) => runAction(e, action)}>
                            <Icon size={16} aria-hidden="true" class="shrink-0"/><span class="min-w-0 break-words">{action.label}<span class="sr-only">{riskHint[action.risk]}{expired ? ', expired' : ''}</span></span>
                          </Button>
                        {/if}
                      {/each}
                    </div>
                    {#if eventActions.some((a) => a.risk !== 'safe' && isExpired(a, clock))}<p class="mt-2 text-body-sm text-muted-foreground">Suggested actions stay valid for 15 minutes in this sign-in. Ask Chatty again to have them checked anew.</p>{/if}
                    {#each eventActions as action (action.proposal)}
                      {@const outcome = outcomes[action.proposal]}
                      {#if outcome}<p class="mt-2 flex items-start gap-1.5 text-body-sm {outcome.ok ? 'text-success' : 'text-destructive'}">{#if outcome.ok}<Check size={16} aria-hidden="true" class="mt-0.5 shrink-0"/>{:else}<CircleAlert size={16} aria-hidden="true" class="mt-0.5 shrink-0"/>{/if}<span class="min-w-0 break-words">{outcome.text}</span></p>{/if}
                    {/each}
                  {/if}
                  {#if eventSuggestions.length}
                    <div class="mt-3 flex flex-wrap gap-2" role="group" aria-label="Suggested follow-up questions">
                      {#each eventSuggestions as suggestion (suggestion)}
                        <button type="button" class="chatty-element chatty-suggestion" disabled={!canSend} onclick={() => void send(suggestion)}>
                          <MessageSquarePlus size={16} aria-hidden="true" class="shrink-0"/><span class="min-w-0 break-words">{suggestion}</span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                  {#if event.body.elements_omitted}<p class="mt-2 text-body-sm text-muted-foreground">{event.body.elements_omitted === 1 ? 'One link' : `${event.body.elements_omitted} links`} could not be verified and {event.body.elements_omitted === 1 ? 'was' : 'were'} left out.</p>{/if}
                {/if}
                {#each event.body.sources ?? [] as source}<details class="mt-2 text-body-sm"><summary class="cursor-pointer underline">{source.heading || source.title}</summary><pre class="mt-2 whitespace-pre-wrap">{source.body}</pre></details>{/each}
                {#if event.kind === 'question' && active?.id === event.runId && active.status === 'waiting_input'}<div class="mt-2 flex flex-wrap gap-2">{#each event.body.options ?? [] as option}<button class="rounded-md border p-2" disabled={!canSend} onclick={() => void send(option)}>{option}</button>{/each}</div>{/if}
              {:else if event.kind === 'action'}
                <p class="font-medium">{event.body.description}</p>
                <details class="mt-2"><summary class="cursor-pointer">View change</summary><pre class="max-h-52 overflow-auto whitespace-pre-wrap text-body-sm">{JSON.stringify(event.body.arguments, null, 2)}</pre><p class="mt-2 text-body-sm">Current state</p><pre class="max-h-40 overflow-auto whitespace-pre-wrap text-body-sm">{JSON.stringify(event.body.before, null, 2)}</pre></details>
                {#if pending(event)}<div class="mt-3 flex gap-3"><button class="rounded-md bg-primary px-3 py-2 text-primary-foreground" disabled={busy} onclick={() => void operation(() => api.post(`/admin/chatty/actions/${event.body.id}/decision`, { generation: $session.data!.generation, approve: true }))}>Confirm</button><button disabled={busy} onclick={() => void operation(() => api.post(`/admin/chatty/actions/${event.body.id}/decision`, { generation: $session.data!.generation, approve: false }))}>Reject</button></div>{/if}
              {:else if event.kind === 'result'}
                <p>Change {event.body.status === 'succeeded' ? 'applied' : event.body.status === 'approved' ? 'confirmed' : event.body.status === 'rejected' ? 'rejected' : event.body.status === 'failed' ? 'failed' : event.body.status}</p>
                {#if event.body.result}<details><summary>Result record</summary><pre class="max-h-52 overflow-auto whitespace-pre-wrap text-body-sm">{JSON.stringify({ action: event.body.tool, result: event.body.result }, null, 2)}</pre></details>{/if}
                {#if event.body.href?.startsWith('/admin/')}<a class="underline" href={event.body.href}>Open in the orchestrator</a>{/if}
              {:else}<p class="text-body-sm text-muted-foreground">{event.body.text ?? event.body.status}</p>{/if}
            </article>
          {/each}
          <div bind:this={bottom}></div>
        </div>
        <div class="px-3">{#if unreadOutput}<Button variant="outline" size="sm" onclick={followLatest}>Show new messages</Button>{/if}</div>
        <ChattyActionDialog element={pendingAction} bind:open={actionOpen} onOutcome={(proposal, outcome) => { outcomes = { ...outcomes, [proposal]: outcome }; }}/>
        <div class="border-t p-3">
          {#if !$status.data.ready}<p class="mb-2 text-body-sm text-muted-foreground">Chatty is not available right now. Check that an engine is switched on with a verified account, quota left and a working verification runner, then the Chatty settings under <a class="underline" href={`${base}/settings#chatty`}>Settings</a>.</p>{/if}
          {#if error || $session.error}<p class="mb-2 text-body text-destructive" role="alert">{error || $session.error?.message}</p>{/if}
          {#if active}<div class="mb-2 flex items-center justify-between text-body-sm text-muted-foreground"><span>{active.status === 'waiting_confirmation' ? 'Waiting for your confirmation' : active.status === 'waiting_input' ? 'Waiting for your answer' : active.status === 'queued' ? 'Queued' : 'Chatty is working…'}</span><button class="flex items-center gap-1" aria-label="Stop request" disabled={busy} onclick={() => void operation(() => api.post(`/admin/chatty/runs/${active.id}/cancel`))}><Square size={12}/> Stop</button></div>{/if}
          <form class="flex items-end gap-2" onsubmit={(e) => { e.preventDefault(); void send(); }}>
            <textarea bind:this={input} bind:value={draft} oninput={() => draftRevision++} aria-label="Message to Chatty" placeholder="Ask Chatty…" rows="2" maxlength="16000" class="max-h-36 min-w-0 flex-1 resize-y rounded-md border bg-background p-2 text-body" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } }}></textarea>
            <button type="submit" class="icon-button bg-primary text-primary-foreground disabled:opacity-40" aria-label="Send message" disabled={!canSend || !draft.trim()}><Send size={18}/></button>
          </form>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{/if}

<style>
  .selection-button { flex-shrink: 0; border-radius: .375rem; padding: .375rem .625rem; font-size: .75rem; line-height: 1rem; font-weight: 500; background: hsl(var(--muted)); color: hsl(var(--muted-foreground)); transition: background-color .15s, color .15s; }
  .selection-button:hover { color: hsl(var(--foreground)); }
  .selection-button[aria-pressed="true"] { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
  .selection-button:disabled { cursor: not-allowed; opacity: .5; }
  .selection-button:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }
  .chatty-suggestion { display: inline-flex; max-width: 100%; align-items: center; gap: .5rem; min-height: 2.25rem; border: 1px dashed hsl(var(--input)); border-radius: var(--radius-sm); background: hsl(var(--background)); padding: .375rem .75rem; text-align: left; font-size: .875rem; line-height: 1.25rem; transition: background-color var(--dur, .12s); }
  .chatty-suggestion:hover:not(:disabled) { background: hsl(var(--accent)); color: hsl(var(--accent-foreground)); }
  .chatty-suggestion:disabled { cursor: not-allowed; opacity: .5; }
  .chatty-suggestion:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }
  :global(.chatty-action-danger) { border: 1px solid hsl(var(--destructive)); color: hsl(var(--destructive)); }
  @media (any-pointer: coarse) { :global(.chatty-element) { min-height: 44px; } }
  :global(.chatty-launcher) { position: fixed; right: 1.25rem; bottom: 1.25rem; z-index: 40; width: 52px; height: 52px; border-radius: var(--radius); color: hsl(var(--primary)); background: hsl(var(--background)); border: 1px solid hsl(var(--border)); box-shadow: var(--shadow-pop); padding: 4px; }
  :global(.chatty-launcher:focus-visible), :global(.icon-button:focus-visible) { outline: 2px solid hsl(var(--ring)); outline-offset: 3px; }
  :global(.chatty-panel) { position: fixed; right: 1.25rem; bottom: 5.25rem; z-index: 50; width: min(420px, calc(100vw - 2rem)); height: min(640px, calc(100dvh - 7rem)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--background)); color: hsl(var(--foreground)); box-shadow: var(--shadow-pop); }
  :global(.icon-button) { display: inline-flex; align-items: center; justify-content: center; min-width: 36px; min-height: 36px; border-radius: .5rem; }
  .offline { position: absolute; width: 10px; height: 10px; border-radius: 100%; background: hsl(var(--muted-foreground)); right: 2px; bottom: 2px; }
  .thinking { animation: ponder 1.8s ease-in-out infinite; }
  @keyframes ponder { 50% { transform: rotate(-5deg) translateY(-2px); } }
  @media (prefers-reduced-motion: reduce) { .thinking { animation: none; } }
  @media (max-width: 767px) { :global(.chatty-launcher) { bottom: calc(.375rem + env(safe-area-inset-bottom)); right: .5rem; z-index: 41; } :global(.chatty-panel) { inset: .5rem; bottom: calc(.5rem + env(safe-area-inset-bottom)); width: auto; height: auto; } }
</style>
