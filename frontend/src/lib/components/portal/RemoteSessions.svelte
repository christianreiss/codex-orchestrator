<script lang="ts">
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { tick, type Snippet } from "svelte";
  import { toStore } from "svelte/store";
  import { createQuery, createMutation } from "@tanstack/svelte-query";
  import { base } from "$app/paths";
  import { api } from "$lib/api/client";
  import type { DaemonHost, RemoteSession } from "$lib/api/hostDaemons";
  import type { AgentSessionRow } from "$lib/api/agentSessions";
  import type { Engine } from "$lib/portal/types";
  import { hostBlockReason, continuationBlockReason, remoteState, remoteForAgent } from "$lib/portal/remote-sessions";
  import { listTime } from "$lib/portal/grouping";
  import { authStore } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Sheet from "$lib/components/ui/sheet";
  import ConversationRow from "./ConversationRow.svelte";
  import BotIcon from "@lucide/svelte/icons/bot";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";

  let { compact = false, active = true, hosts, agents, loading, error, stale, selectedId = $bindable(null), startOpen = $bindable(false), fixedHost, refresh, onselect, conversation }: {
    compact?: boolean; active?: boolean; hosts: DaemonHost[]; agents: AgentSessionRow[]; loading: boolean; error: Error | null; stale: boolean;
    selectedId?: string | null; startOpen?: boolean; fixedHost?: number; refresh: () => void;
    onselect: (id: string | null) => void; conversation: Snippet<[string, Snippet, boolean]>;
  } = $props();
  const canRead = $derived($authStore.can("agent_portal.reveal_transcript"));
  const canManage = $derived($authStore.can("agent_messaging.manage"));
  let search = $state("");
  let filter = $state("current");
  let engineFilter = $state("all");
  let hostId = $state(0);
  let engine = $state<Engine>("codex");
  let title = $state("");
  let cwd = $state("");
  let prompt = $state("");
  let planFirst = $state(false);
  let drafts = $state<Record<string, string>>({});
  let detailsOpen = $state(false);
  let heading = $state<HTMLHeadingElement | null>(null);
  const entries = $derived(hosts.flatMap(host => host.sessions.map(session => ({ session, host }))));
  const selectedEntry = $derived(entries.find(entry => entry.session.id === selectedId));
  const detail = createQuery<RemoteSession>(toStore(() => ({
    queryKey: ["daemon-sessions", selectedId], enabled: active && !!selectedId && canRead,
    queryFn: ({ queryKey, signal }) => api.get<RemoteSession>(`/admin/daemon-sessions/${queryKey[1]}`, { signal }),

  })));
  const selected = $derived($detail.data ?? selectedEntry?.session);
  const selectedHost = $derived(selectedEntry?.host);
  const native = $derived(selected ? (agents.find(agent => agent.id === selected!.sessionId) ?? agents.find(agent => remoteForAgent(agent, [selected!]))) : undefined);
  const visible = $derived(entries.filter(({ session, host }) => {
    const terminal = ["closed", "failed", "unknown"].includes(session.status);
    return (!fixedHost || host.host_id === fixedHost) && (engineFilter === "all" || session.engine === engineFilter)
      && (filter === "all" || (filter === "ended" ? terminal : !terminal))
      && `${session.title} ${host.fqdn} ${session.cwd} ${session.engine}`.toLowerCase().includes(search.trim().toLowerCase());
  }).sort((a, b) => (b.session.lastActivityAt ?? b.session.createdAt ?? "").localeCompare(a.session.lastActivityAt ?? a.session.createdAt ?? "") || a.session.id.localeCompare(b.session.id)));
  const host = $derived(hosts.find(row => row.host_id === hostId));
  const startReason = $derived(!canManage ? "Remote session management is required." : error || stale ? "Refresh host status before starting work." : hostBlockReason(host) || (host?.engines?.includes(engine) ? "" : "This engine is not ready on the host."));
  const resumeReason = $derived(!canManage || !canRead ? "Conversation access and remote session management are required." : error || stale || $detail.isError ? "Refresh session status before continuing." : native?.pending_prompt ? "Answer the pending question when the agent is reachable." : selected ? continuationBlockReason(selected, selectedHost) : "Select a session.");
  // Plan mode is a native Claude/Grok permission mode; Codex has none, and a
  // daemon older than cxx 0.9.146 would ignore it, so the server refuses both.
  const planReason = $derived(engine === "codex" ? "Codex has no plan mode; its sessions always run with the host's security posture." : (host?.permission_mode_version ?? 0) < 1 ? "This host's daemon predates plan mode. Update cxx to 0.9.146 or newer." : "");
  const inPlan = $derived(selected?.permissionMode === "plan");
  const approveReason = $derived(!canManage || !canRead ? "Conversation access and remote session management are required." : error || stale || $detail.isError ? "Refresh session status before approving." : selected && ["running", "queued", "stopping"].includes(selected.status) ? "Wait until the agent has finished presenting its plan." : selected ? continuationBlockReason(selected, selectedHost) : "Select a session.");
  const live = $derived(selected?.status === "running" || Boolean(selected?.status === "waiting" && native?.pending_prompt && !native.read_only));
  $effect(() => {
    if (fixedHost) hostId = fixedHost;
    else if (!hostId && hosts.length) hostId = (hosts.find(row => !hostBlockReason(row)) ?? hosts[0]).host_id;
  });
  $effect(() => {
    if (host?.engines?.length && !host.engines.includes(engine)) engine = host.engines[0];
  });
  $effect(() => { if (active) onselect(native?.id ?? null); });
  $effect(() => { if (!active) startOpen = false; });

  // A retry after a lost response retains the exact request key. Selection and
  // edits during a request must never change that request's target or body.
  const keys = new Map<string, string>();
  function requestKey(kind: string, body: unknown) {
    const signature = JSON.stringify([$authStore.user?.id, kind, body]);
    let key = keys.get(signature);
    if (!key) { key = crypto.randomUUID(); keys.set(signature, key); }
    return { signature, key };
  }
  type StartBody = { host_id: number; engine: Engine; title: string; cwd: string; prompt: string; permission_mode?: "plan" };
  const start = createMutation({
    mutationFn: ({ body, key }: { body: StartBody; key: string }) => api.post<{ session_id: string }>("/admin/daemon-sessions", { ...body, client_message_id: key }),
  });
  async function submitStart() {
    if (startReason || !title.trim() || !prompt.trim() || $start.isPending) return;
    const body: StartBody = { host_id: hostId, engine, title: title.trim(), cwd: cwd.trim() || host?.default_cwd || "", prompt: prompt.trim(), ...(planFirst && !planReason ? { permission_mode: "plan" as const } : {}) };
    const { key, signature } = requestKey("start", body);
    try {
      const result = await $start.mutateAsync({ body, key });
      keys.delete(signature); selectedId = result.session_id; filter = "all"; startOpen = false;
      if (prompt.trim() === body.prompt) prompt = "";
      refresh();
    } catch { /* The inline error and unchanged draft remain available. */ }
  }
  const turn = createMutation({ mutationFn: ({ id, text, key }: { id: string; text: string; key: string }) => api.post(`/admin/daemon-sessions/${id}/messages`, { prompt: text, client_message_id: key }) });
  async function resume() {
    if (!selected || resumeReason || $turn.isPending || $stop.isPending) return;
    const id = selected.id, text = (drafts[id] ?? "").trim();
    if (!text) return;
    const { key, signature } = requestKey("resume", { id, text });
    try {
      await $turn.mutateAsync({ id, text, key }); keys.delete(signature);
      if ((drafts[id] ?? "").trim() === text) drafts = { ...drafts, [id]: "" };
      refresh();
    } catch { /* Keep the request key and draft for an explicit retry. */ }
  }
  // With the plan question still open, approval must answer that question
  // (the portal answer resumes the agent) after switching the mode without a
  // resume of its own; otherwise the session resumes with the execution turn.
  // Both steps are idempotent, so a retry after a lost response is safe.
  const approve = createMutation({
    mutationFn: async ({ id, key, agent, prompt }: { id: string; key: string; agent?: string; prompt?: { id: string; version: number; choice: boolean } }) => {
      if (!agent || !prompt) return api.post(`/admin/daemon-sessions/${id}/permission-mode`, { mode: "default", client_message_id: key });
      await api.post(`/admin/daemon-sessions/${id}/permission-mode`, { mode: "default" });
      return api.post(`/admin/agent-sessions/${encodeURIComponent(agent)}/prompts/${encodeURIComponent(prompt.id)}/answer`, {
        client_message_id: key, version: prompt.version,
        ...(prompt.choice ? { answer: "approve", metadata: { choice_value: "approve" } } : { answer: "Approve plan & execute" }),
      });
    },
  });
  async function approvePlan() {
    if (!selected || !inPlan || approveReason || $approve.isPending || $turn.isPending || $stop.isPending) return;
    const id = selected.id, open = native?.pending_prompt;
    const prompt = native && open ? { id: open.id, version: open.version, choice: open.answer_mode !== "text" && Boolean(open.choices?.some(choice => choice.value === "approve")) } : undefined;
    const { key, signature } = requestKey("approve-plan", { id, prompt: prompt?.id ?? null });
    try {
      await $approve.mutateAsync({ id, key, agent: prompt ? native!.id : undefined, prompt }); keys.delete(signature);
      refresh(); void $detail.refetch();
    } catch { /* Keep the request key so a retry cannot resume the session twice. */ }
  }
  const stop = createMutation({ mutationFn: (id: string) => api.post(`/admin/daemon-sessions/${id}/stop`, {}), onSuccess: () => refresh() });
  async function select(id: string) { selectedId = id; detailsOpen = false; if (!$turn.isPending) $turn.reset(); if (!$stop.isPending) $stop.reset(); if (!$approve.isPending) $approve.reset(); await tick(); heading?.focus(); }
  async function back() { const id = selectedId; selectedId = null; await tick(); document.getElementById(`remote-${id}`)?.focus(); }
</script>
<DraftGuard dirty={Object.values(drafts).some((draft) => draft.trim().length > 0)} />

{#if active}
  {#if error}<div role="alert" class="mb-3 flex items-center justify-between rounded-md border border-destructive/30 p-3 text-body-sm"><span>Remote sessions could not be refreshed. {error.message}</span><Button variant="outline" size="sm" onclick={refresh}>Retry remote sessions</Button></div>{/if}
  <div class={compact ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "grid h-[calc(75dvh-4rem)] min-h-[28rem] grid-cols-1 overflow-hidden rounded-md border bg-card lg:h-[calc(100dvh-19.5rem)] lg:grid-cols-[22rem_minmax(0,1fr)]"}>
    {#if !compact}<section aria-label="Remote session directory" class="min-h-0 min-w-0 flex-col border-r {selectedId ? 'hidden lg:flex' : 'flex'}">
      <div class="space-y-2 border-b p-3">
        <div class="flex gap-2">
          <Input aria-label="Find a remote session" type="search" placeholder="Search sessions or hosts" bind:value={search} class="h-8 min-w-0 bg-muted text-caption" />
          <select aria-label="Remote engine" bind:value={engineFilter} class="h-8 w-28 shrink-0 rounded-md bg-muted px-2 text-caption"><option value="all">All engines</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option></select>
        </div>
        <div class="flex gap-1" role="group" aria-label="Show remote sessions">
          {#each [{ key: 'current', label: 'Current' }, { key: 'ended', label: 'Ended' }, { key: 'all', label: 'All' }] as item}
            <button class="rounded-full px-2.5 py-1 text-caption {filter === item.key ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}" aria-pressed={filter === item.key} onclick={() => filter = item.key}>{item.label}</button>
          {/each}
        </div>
        {#if fixedHost}<p class="text-caption text-muted-foreground">{hosts.find(row => row.host_id === fixedHost)?.fqdn ?? `Host #${fixedHost}`} · <a class="text-primary underline" href={`${base}/clients?view=remote`}>All hosts</a></p>{/if}
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        {#if loading}<p role="status" class="p-5 text-body-sm text-muted-foreground">Loading remote sessions…</p>
        {:else if !visible.length}<div class="px-4 py-8 text-center"><BotIcon class="mx-auto h-6 w-6 text-muted-foreground" /><h2 class="mt-3 text-body-sm font-medium">No remote sessions match</h2><p class="mt-1 text-caption text-muted-foreground">Start a session or change the search and status filter.</p></div>
        {:else}{#each visible as { session, host } (session.id)}
          {@const state = remoteState(session.status)}
          <ConversationRow id={`remote-${session.id}`} engine={session.engine} presence={state.presence} title={session.title} time={session.lastActivityAt ? listTime(session.lastActivityAt, new Date()) : ""} directory={host.fqdn ?? `Host #${host.host_id}`} preview={`${session.engine} · ${state.label}`} selected={selectedId === session.id} aria-pressed={selectedId === session.id} logo onclick={() => select(session.id)} />
        {/each}{/if}
      </div>
    </section>
    {/if}<section aria-label="Remote session conversation" class="min-h-0 min-w-0 flex-col {selectedId || compact ? 'flex flex-1' : 'hidden lg:flex'}">
      {#if selectedId}
        <header class="flex items-center gap-2 border-b px-3 py-2">
          <Button variant="ghost" size="icon" class="shrink-0 lg:hidden" aria-label="Back to remote sessions" onclick={back}><ChevronLeftIcon class="h-5 w-5" /></Button>
          <div class="min-w-0 flex-1"><h2 bind:this={heading} tabindex="-1" class="truncate text-body-sm font-semibold outline-none">{selected?.title ?? 'Remote session'}</h2><p class="truncate text-caption text-muted-foreground">{selectedHost?.fqdn ?? 'Host'} · {remoteState(selected?.status ?? 'queued').label}{inPlan ? ' · Plan mode' : ''}</p></div>
          <Button variant="ghost" size="sm" aria-expanded={detailsOpen} onclick={() => detailsOpen = !detailsOpen}>Details</Button>
        </header>
        {#if detailsOpen && selected}<div class="max-h-[40%] shrink-0 space-y-2 overflow-y-auto border-b bg-muted/20 p-4 text-caption">
          <p class="break-all">{selected.engine} · {selected.cwd}</p>
          {#if selectedHost}<a class="text-primary underline" href={`${base}/hosts/${selectedHost.host_id}`}>Host settings</a>{/if}
          {#if canRead}{#each selected.operations ?? [] as operation}<div class="whitespace-pre-wrap break-words border-t pt-2"><p>{operation.status}</p>{#if operation.result?.error}<p class="text-destructive">{operation.result.error}</p>{/if}{#if operation.result?.reply}<p>{operation.result.reply}</p>{/if}</div>{/each}{/if}
          {#if canManage && !['closed', 'stopping'].includes(selected.status)}<Button variant="outline" size="sm" disabled={$stop.isPending || $turn.isPending || !!error || stale} onclick={() => $stop.mutate(selected!.id)}>End session</Button>{/if}
        </div>{/if}
        {#if $detail.error}<p role="alert" class="px-4 py-2 text-body-sm text-destructive">{$detail.error.message} <button class="underline" onclick={() => $detail.refetch()}>Retry session</button></p>{/if}
        {#if inPlan && selected && !['closed', 'failed', 'unknown'].includes(selected.status)}<div class="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2 text-body-sm">
          <p class="min-w-0 flex-1 text-muted-foreground">Plan mode: the agent proposes a plan and changes nothing. Approving switches it to the host's normal permissions and tells it to execute the plan; answering its plan question directly keeps plan mode.</p>
          {#if canRead && canManage}<Button size="sm" disabled={!!approveReason || $approve.isPending || $turn.isPending || $stop.isPending} onclick={() => void approvePlan()}>{$approve.isPending ? 'Approving…' : 'Approve plan & execute'}</Button>{/if}
          {#if approveReason && canRead && canManage}<p class="w-full text-caption text-muted-foreground">{approveReason}</p>{/if}
          {#if $approve.error && $approve.variables?.id === selected.id}<p role="alert" class="w-full text-body-sm text-destructive">{$approve.error.message} Retry sends the same request.</p>{/if}
        </div>{/if}
        {#if $stop.error && $stop.variables === selectedId}<p role="alert" class="px-4 py-2 text-body-sm text-destructive">{$stop.error.message}</p>{/if}
        {#if native}{@render conversation(native.id, controls, live)}
        {:else}<div class="grid flex-1 place-content-center p-6 text-center"><BotIcon class="mx-auto h-8 w-8 text-muted-foreground/60" /><h3 class="mt-3 text-body-sm font-medium">{selected ? remoteState(selected.status).label : 'Loading session…'}</h3><p class="mt-1 max-w-sm text-body-sm text-muted-foreground">{selected ? remoteState(selected.status).detail : 'Waiting for session details.'}</p></div>{@render controls()}{/if}
      {:else}<div class="grid flex-1 place-content-center p-8 text-center"><BotIcon class="mx-auto h-8 w-8 text-muted-foreground/60" /><h2 class="mt-3 text-body-sm font-medium">Select a remote session</h2><p class="mt-1 max-w-xs text-caption text-muted-foreground">Start work on a host, follow its conversation and continue it here.</p></div>{/if}
    </section>
  </div>
{/if}

{#snippet controls()}
  {#if !live && selected}
    <footer class="shrink-0 space-y-2 border-t p-3 sm:p-4">
      {#if resumeReason}<p class="text-caption text-muted-foreground">{resumeReason}</p>{/if}
      {#if $turn.error && $turn.variables?.id === selected.id}<p role="alert" class="text-body-sm text-destructive">{$turn.error.message} Your draft is kept. Retry sends the same request.</p>{/if}
      {#if canRead && canManage}<form class="flex items-end gap-2" onsubmit={event => { event.preventDefault(); void resume(); }}>
        <Textarea aria-label="Continue remote session" placeholder="Next instruction…" rows={1} maxlength={100000} value={drafts[selected.id] ?? ''} oninput={event => drafts = { ...drafts, [selected!.id]: event.currentTarget.value }} class="min-h-9 flex-1 resize-none" />
        <Button type="submit" disabled={!!resumeReason || !(drafts[selected.id] ?? '').trim() || $turn.isPending || $stop.isPending}>{$turn.isPending ? 'Continuing…' : 'Continue'}</Button>
      </form>{/if}
    </footer>
  {/if}
{/snippet}

<Sheet.Root bind:open={startOpen}>
  <Sheet.Content class="flex w-full flex-col overflow-y-auto sm:max-w-lg">
    <Sheet.Header><Sheet.Title>Start remote session</Sheet.Title><Sheet.Description>Choose a host and give the agent its first instruction.</Sheet.Description></Sheet.Header>
    <form class="mt-6 space-y-5" onsubmit={event => { event.preventDefault(); void submitStart(); }}>
      <div class="space-y-1.5"><label class="text-body-sm font-medium" for="remote-host">Host</label><select id="remote-host" class="h-9 w-full rounded-md border bg-background px-3 text-body-sm" bind:value={hostId}><option value={0}>Choose a host</option>{#each hosts as row}<option value={row.host_id}>{row.fqdn ?? `Host #${row.host_id}`}{!row.enabled ? ' · Disabled' : ''}</option>{/each}</select></div>
      <div class="space-y-1.5"><label class="text-body-sm font-medium" for="remote-engine">Engine</label><select id="remote-engine" class="h-9 w-full rounded-md border bg-background px-3 text-body-sm" bind:value={engine}>{#each ['codex', 'claude', 'grok'] as value}<option value={value} disabled={!host?.engines?.includes(value as Engine)}>{value === 'codex' ? 'Codex' : value === 'claude' ? 'Claude' : 'Grok'}</option>{/each}</select></div>
      <div class="space-y-1.5"><label class="text-body-sm font-medium" for="remote-title">Title</label><Input id="remote-title" bind:value={title} maxlength={160} required placeholder="What should this session accomplish?" /></div>
      <div class="space-y-1.5"><label class="text-body-sm font-medium" for="remote-prompt">Instruction</label><Textarea id="remote-prompt" bind:value={prompt} maxlength={100000} required rows={5} placeholder="Describe the task…" /></div>
      <details class="rounded-md border p-3"><summary class="cursor-pointer text-body-sm font-medium">Working directory</summary><div class="mt-3 space-y-1.5"><label class="text-body-sm" for="remote-cwd">Working directory</label><Input id="remote-cwd" bind:value={cwd} maxlength={1024} placeholder={host?.default_cwd || 'Service account home directory'} /></div></details>
      <fieldset class="space-y-1.5 rounded-md border p-3">
        <legend class="px-1 text-body-sm font-medium">Permission mode</legend>
        <label class="flex items-start gap-2 text-body-sm"><input type="checkbox" class="mt-1" bind:checked={planFirst} disabled={!!planReason} aria-describedby="remote-plan-help" /><span>Plan first, then wait for my approval</span></label>
        <p id="remote-plan-help" class="text-caption text-muted-foreground">{planReason || "The agent runs in native plan mode, proposes a plan and asks you to approve, reject or revise it before it changes anything."}</p>
      </fieldset>
      {#if startReason}<p role="status" class="text-body-sm text-muted-foreground">{startReason}</p>{/if}
      {#if $start.error}<p role="alert" class="text-body-sm text-destructive">{$start.error.message} Your instruction is kept. Retry sends the same request.</p>{/if}
      <Button type="submit" class="w-full" disabled={!!startReason || !title.trim() || !prompt.trim() || $start.isPending}>{$start.isPending ? 'Starting…' : 'Start session'}</Button>
    </form>
  </Sheet.Content>
</Sheet.Root>
