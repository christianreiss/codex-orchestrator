<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import CopyButton from "$lib/components/ui/copy-button/copy-button.svelte";
  import EngineAvatar from "$lib/components/portal/EngineAvatar.svelte";
  import { authStore } from "$lib/stores/auth";
  import { engineLabel, isEngine } from "$lib/constants/engines";
  import { forceCloseMutation, requestCloseMutation } from "$lib/api/agentSessions";
  import {
    disconnectCommunicatorMutation,
    stopDaemonSessionMutation,
    terminateCommunicatorMutation,
    type Topology,
    type TopologyAgent,
    type TopologyCommunicator,
    type TopologyDisconnect,
  } from "$lib/api/topology";
  import { actionReason, ageLabel, communicatorLabel, shortId, type ActionPhase, type GraphItem } from "$lib/topology/model";
  import ConfirmAction from "./ConfirmAction.svelte";
  import type { Presence } from "$lib/portal/types";

  type Props = {
    snapshot: Topology | undefined;
    item: GraphItem | null;
    onselect: (id: string | null) => void;
  };
  let { snapshot, item, onselect }: Props = $props();

  const node = $derived(item?.node ?? null);
  const communicator = $derived(node?.kind === "communicator" ? node : null);
  const agent = $derived(node?.kind === "agent" ? node : null);
  const ghost = $derived(item?.ghost ?? null);
  const agentsById = $derived(new Map((snapshot?.agents ?? []).map((a) => [a.id, a])));
  const communicatorsById = $derived(new Map((snapshot?.communicators ?? []).map((c) => [c.id, c])));
  const children = $derived(
    communicator ? communicator.agent_ids.flatMap((id) => (agentsById.get(id) ? [agentsById.get(id)!] : [])) : [],
  );
  const parent = $derived(agent && agent.association.parent_id !== "server" ? (communicatorsById.get(agent.association.parent_id) ?? null) : null);

  const canPortal = $derived($authStore.can("agent_portal.manage"));
  const canRemote = $derived($authStore.can("agent_messaging.manage"));

  // ── actions ────────────────────────────────────────────────────────────────
  type ActionKind = "disconnect" | "terminate" | "request_close" | "stop_process" | "end_record";
  // The target is captured when the dialog opens: after a disconnect the live
  // tree no longer has it, and the dialog must keep saying who it was about.
  type Frozen = { kind: ActionKind; id: string; communicator: TopologyCommunicator | null; agent: TopologyAgent | null; affected: string[] };
  let action = $state<Frozen | null>(null);
  let phase = $state<ActionPhase>("confirm");
  let errorMessage = $state("");
  let note = $state("");
  let dialogOpen = $state(false);
  let outcome = $state<{ title: string; lines: string[]; tone?: "success" | "warning" } | null>(null);

  const disconnect = disconnectCommunicatorMutation();
  const terminate = terminateCommunicatorMutation();
  const requestClose = requestCloseMutation();
  const forceClose = forceCloseMutation();
  const stopDaemon = stopDaemonSessionMutation();

  function begin(kind: ActionKind, id: string) {
    const onCommunicator = kind === "disconnect" || kind === "terminate";
    const frozenCommunicator = onCommunicator ? $state.snapshot(communicatorsById.get(id) ?? communicator) : null;
    const frozenAgent = onCommunicator ? null : $state.snapshot(agentsById.get(id) ?? agent);
    action = {
      kind,
      id,
      communicator: frozenCommunicator ?? null,
      agent: frozenAgent ?? null,
      affected: (frozenCommunicator?.agent_ids ?? []).flatMap((childId) => (agentsById.get(childId) ? [agentLine(agentsById.get(childId)!)] : [])),
    };
    phase = "confirm";
    errorMessage = "";
    note = "";
    outcome = null;
    dialogOpen = true;
  }
  function close() {
    dialogOpen = false;
    action = null;
  }

  const targetCommunicator = $derived(action?.communicator ?? null);
  const targetAgent = $derived(action?.agent ?? null);
  // What the live tree says now about the target, for the follow-up lines.
  const departure = $derived(action && (action.kind === "disconnect" || action.kind === "terminate") ? (snapshot?.recent_disconnects.find((d) => d.id === action!.id) ?? null) : null);
  const liveAgent = $derived(action?.agent ? (agentsById.get(action.id) ?? action.agent) : null);

  async function confirm() {
    if (!action) return;
    phase = "pending";
    errorMessage = "";
    try {
      if (action.kind === "disconnect" && targetCommunicator) {
        const result = await $disconnect.mutateAsync({ target: targetCommunicator, note: note.trim() || undefined });
        outcome = {
          title: result.outcome === "closed" ? "Connection closed" : "Close requested, not yet confirmed",
          lines: [
            result.outcome === "closed"
              ? "The server confirmed the socket is closed."
              : "The server asked the socket to close but has not seen it end. Check the live view before acting again.",
            `${result.affected.agent_ids.length} agent session${result.affected.agent_ids.length === 1 ? "" : "s"} were carried by it. They reappear under the new connection as each next speaks to the server (about 15 s).`,
          ],
        };
      } else if (action.kind === "terminate" && targetCommunicator) {
        const result = await $terminate.mutateAsync({ target: targetCommunicator, note: note.trim() || undefined });
        const pid = result.process.pid ? ` (pid ${result.process.pid})` : "";
        outcome =
          result.outcome === "terminated"
            ? { title: "Process stopped", lines: [`The process${pid} acknowledged the request, and its connection to the server then closed.`] }
            : result.outcome === "acknowledged"
              ? { title: "Acknowledged, still connected", tone: "warning", lines: [`The process${pid} said it is stopping, but its connection is still open. Check the live view; nothing is assumed.`] }
              : result.outcome === "refused"
                ? { title: "The process declined", tone: "warning", lines: ["It reported that it cannot stop itself on request. Nothing was stopped."] }
                : { title: "No acknowledgement", tone: "warning", lines: ["The request was sent, but the process did not answer in time. As far as the server can tell it is still running."] };
      } else if (action.kind === "request_close" && targetAgent) {
        await $requestClose.mutateAsync({ id: targetAgent.id, note: note.trim() || undefined });
        outcome = { title: "Close request queued", lines: ["The agent picks it up the next time it listens; the live view shows when it does."] };
      } else if (action.kind === "stop_process" && targetAgent?.daemon) {
        const result = await $stopDaemon.mutateAsync({ daemonSessionId: targetAgent.daemon.session_id });
        outcome = { title: "Stop requested", lines: [`Daemon session is now “${result.status}”. The host daemon stops the process on its next sweep.`] };
      } else if (action.kind === "end_record" && targetAgent) {
        const result = await $forceClose.mutateAsync({ id: targetAgent.id, note: note.trim() || undefined });
        outcome = {
          title: result.forced ? "Session record ended" : "Already ended",
          lines: [result.forced ? "The server now treats the session as finished." : "Nothing changed: the session had already ended."],
        };
      } else {
        throw new Error("The target is no longer connected.");
      }
      phase = "done";
    } catch (error) {
      const failure = error as { status?: number; code?: string; message?: string };
      errorMessage =
        failure.code === "communicator_terminate_unsupported"
          ? "This communicator never announced that it can be stopped remotely, so it was not asked."
          : failure.code === "communicator_not_connected" || failure.status === 404
          ? "That target is already gone, so there was nothing to act on."
          : failure.code === "communicator_target_changed"
            ? "The connection changed since you selected it. Select it again."
            : (failure.message ?? "The action failed.");
      phase = "error";
    }
  }

  const presenceVariant = (presence: string) =>
    presence === "listening" || presence === "working" ? "success" : presence === "idle" ? "warning" : "secondary";
  const healthVariant = (health: string) => (health === "live" ? "success" : health === "closing" ? "destructive" : "warning");
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
  const agentLine = (a: TopologyAgent) => `${a.name} · ${isEngine(a.engine) ? engineLabel(a.engine) : a.engine} · ${a.presence}`;
</script>

{#snippet idLink(id: string, closeFirst: boolean)}
  <button type="button" class="underline underline-offset-2" onclick={() => { if (closeFirst) close(); onselect(id); }}>{shortId(id)}</button>{#if communicatorsById.get(id)?.process}{` (pid ${communicatorsById.get(id)!.process!.pid})`}{/if}
{/snippet}

<!-- What followed a departed connection. A successor is shown only when its owner
     identity proves it; a connection from the same host and user is a candidate,
     because separate runtime roots can host distinct owners for one user. -->
{#snippet successorNote(d: TopologyDisconnect | null, closeFirst: boolean)}
  {#if d?.successor_id}
    {d.successor_basis === "same_process" ? "The same process reconnected as" : "A replacement process serving the same runtime connected as"}
    {@render idLink(d.successor_id, closeFirst)}.
  {:else if d && d.candidate_ids.length > 0}
    <span class="text-warning">Unverified:</span>
    {d.candidate_ids.length === 1 ? "a connection" : `${d.candidate_ids.length} connections`} from the same host and user
    appeared since ({#each d.candidate_ids as candidate, index (candidate)}{#if index > 0}, {/if}{@render idLink(candidate, closeFirst)}{/each}),
    but nothing proves {d.candidate_ids.length === 1 ? "it is" : "any is"} this owner coming back.
  {:else}
    No new connection has appeared yet.
  {/if}
{/snippet}

<div class="flex h-full flex-col gap-4 overflow-y-auto" aria-live="polite">
  {#if !node}
    <!-- ── nothing selected: the server and the story so far ─────────────── -->
    <section class="space-y-3">
      <h2 class="text-sm font-semibold">Server</h2>
      {#if snapshot}
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt class="text-muted-foreground">Endpoint</dt><dd class="break-words font-medium">{snapshot.server.label}</dd>
          <dt class="text-muted-foreground">Uptime</dt><dd>{ageLabel(snapshot.server.uptime_s).replace(" ago", "")}</dd>
          <dt class="text-muted-foreground">Communicators</dt><dd>{snapshot.counts.communicators}{snapshot.server.communicator_enabled ? "" : " (transport disabled)"}</dd>
          <dt class="text-muted-foreground">Agents</dt><dd>{snapshot.counts.agents}{snapshot.server.portal_enabled ? "" : " (agent sessions disabled)"}</dd>
          <dt class="text-muted-foreground">Via a communicator</dt><dd>{snapshot.counts.attributed}</dd>
          {#if snapshot.counts.stale > 0}<dt class="text-muted-foreground">Link gone quiet</dt><dd>{snapshot.counts.stale}</dd>{/if}
          <dt class="text-muted-foreground">Direct</dt><dd>{snapshot.counts.unattributed}</dd>
        </dl>
        <p class="text-xs text-muted-foreground">
          This is the connection set held by one API process. An agent hangs off a communicator only when the server saw that
          session's own requests arrive over its socket; otherwise it is shown as direct. Select a node for details and controls.
        </p>
      {/if}
    </section>

    {#if snapshot && snapshot.recent_disconnects.length > 0}
      <section class="space-y-2">
        <h2 class="text-sm font-semibold">Recent disconnects</h2>
        <ul class="space-y-2 text-sm">
          {#each snapshot.recent_disconnects.slice(0, 6) as d (d.id)}
            <li class="rounded-md border p-2">
              <p class="font-medium">{communicatorLabel(d)} <span class="font-normal text-muted-foreground">· {ageLabel(Math.round((Date.now() - Date.parse(d.ended_at)) / 1000))}</span></p>
              <p class="text-xs text-muted-foreground">
                {d.reason === "admin_disconnect" ? `Closed by ${d.actor ?? "an administrator"}` : d.reason === "admin_terminate" ? `Process stopped by ${d.actor ?? "an administrator"}` : "Connection ended"}
                · {@render successorNote(d, false)}
              </p>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="space-y-2">
      <h2 class="text-sm font-semibold">Legend</h2>
      <ul class="space-y-1 text-xs text-muted-foreground">
        <li><span class="legend-dot" style="border-color: hsl(var(--success))"></span> Live link · solid, flowing</li>
        <li><span class="legend-dot" style="border-color: hsl(var(--warning)); border-style: dashed"></span> Quiet or stale · dashed amber</li>
        <li><span class="legend-dot" style="border-color: hsl(var(--muted-foreground)); border-style: dotted"></span> Direct, no communicator · dotted grey</li>
        <li>Agent fill is its engine; the ring is its presence.</li>
      </ul>
    </section>
  {:else if communicator}
    <!-- ── a communicator ─────────────────────────────────────────────────── -->
    <section class="space-y-3">
      <header class="flex flex-wrap items-center gap-2">
        <h2 class="text-base font-semibold">{communicatorLabel(communicator)}</h2>
        {#if ghost}<Badge variant="secondary">Disconnected</Badge>
        {:else}<Badge variant={healthVariant(communicator.health)}>{communicator.health === "live" ? "Live" : communicator.health === "stale" ? "Gone quiet" : "Closing"}</Badge>{/if}
        <Badge variant="outline">cxx {communicator.version}</Badge>
      </header>

      {#if ghost}
        <div class="rounded-md border bg-muted/40 p-3 text-sm">
          <p>
            {ghost.departure?.reason === "admin_disconnect"
              ? `Closed by ${ghost.departure.actor ?? "an administrator"}.`
              : ghost.departure?.reason === "admin_terminate"
                ? `Stopped by ${ghost.departure.actor ?? "an administrator"}; the process acknowledged${ghost.departure.pid ? ` (pid ${ghost.departure.pid})` : ""}.`
                : "The connection ended."}
            {@render successorNote(ghost.departure ?? null, false)}
          </p>
        </div>
      {/if}

      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt class="text-muted-foreground">Host</dt><dd class="break-words">{communicator.host}</dd>
        <dt class="text-muted-foreground">OS user</dt><dd>{communicator.username}</dd>
        <dt class="text-muted-foreground">Connection</dt>
        <dd class="flex items-center gap-1 font-mono text-xs"><span title={communicator.id}>{shortId(communicator.id)}</span><CopyButton value={communicator.id} variant="ghost" size="icon" class="h-6 w-6" aria-label="Copy connection id" /></dd>
        <dt class="text-muted-foreground">Connected</dt><dd>{when(communicator.connected_at)}</dd>
        <dt class="text-muted-foreground">Last heartbeat</dt><dd>{communicator.last_heartbeat_at ? `${ageLabel(Math.round((Date.now() - Date.parse(communicator.last_heartbeat_at)) / 1000))}` : "none yet"}</dd>
        <dt class="text-muted-foreground">Process</dt>
        <dd>{communicator.process ? `pid ${communicator.process.pid}` : "not reported"}{#if communicator.process} <span class="text-muted-foreground">self-reported{communicator.process.started_at ? `, started ${new Date(communicator.process.started_at).toLocaleTimeString()}` : ""}</span>{/if}</dd>
        {#if communicator.process?.runtime_id}
          <dt class="text-muted-foreground">Runtime</dt>
          <dd class="font-mono text-xs" title="Hash of the owner's local socket path: the same value means the same local clients are served">{communicator.process.runtime_id.slice(0, 8)}{#if communicator.process.instance_id} <span class="text-muted-foreground">· instance {communicator.process.instance_id.slice(0, 8)}</span>{/if}</dd>
        {/if}
        <dt class="text-muted-foreground">Local leases</dt><dd>{communicator.leases_reported} <span class="text-muted-foreground">reported by the communicator</span></dd>
        <dt class="text-muted-foreground">Requests</dt><dd>{communicator.requests}</dd>
        <dt class="text-muted-foreground">Last sync</dt><dd>{when(communicator.synced_at)}{#if communicator.sync_errors > 0} · <span class="text-destructive">{communicator.sync_errors} scope{communicator.sync_errors === 1 ? "" : "s"} failing</span>{/if}</dd>
        {#if communicator.remote_address}<dt class="text-muted-foreground">Address</dt><dd class="font-mono text-xs">{communicator.remote_address}</dd>{/if}
        <dt class="text-muted-foreground">Host daemon</dt><dd>{communicator.daemon_attached ? "channel attached" : "not attached"}</dd>
      </dl>
    </section>

    <section class="space-y-2">
      <h3 class="section-label">Agents on this connection ({children.length})</h3>
      {#if children.length === 0}
        <p class="text-sm text-muted-foreground">
          No session traffic has been seen on this connection.{communicator.leases_reported > 0 ? ` The communicator reports ${communicator.leases_reported} local lease${communicator.leases_reported === 1 ? "" : "s"}, which can be sessions that have not spoken to the server through it yet.` : ""}
        </p>
      {:else}
        <ul class="space-y-1">
          {#each children as child (child.id)}
            <li>
              <button type="button" class="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onclick={() => onselect(child.id)}>
                {#if isEngine(child.engine)}<EngineAvatar engine={child.engine} presence={child.presence as Presence} size="xs" />{/if}
                <span class="min-w-0 flex-1 truncate font-medium">{child.name}</span>
                <span class="text-xs text-muted-foreground">{child.association.state === "stale" ? `quiet ${ageLabel(child.association.age_s)}` : child.presence}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if !ghost}
      <section class="sticky bottom-0 mt-auto space-y-2 border-t bg-card pb-1 pt-3">
        <h3 class="section-label">Control</h3>
        <Button variant="outline" class="w-full justify-start text-destructive" disabled={!canPortal || communicator.health === "closing"} onclick={() => begin("disconnect", communicator.id)}>
          Disconnect this communicator…
        </Button>
        <p class="text-xs text-muted-foreground">
          {#if !canPortal}Requires the agent-sessions management permission.
          {:else}Closes this one server connection. The communicator process keeps running and redials within 1–30 s; its agents keep running.{/if}
        </p>
        {#if communicator.can_terminate}
          <Button variant="outline" class="w-full justify-start text-destructive" disabled={!canPortal || communicator.health === "closing"} onclick={() => begin("terminate", communicator.id)}>
            Stop the communicator process…
          </Button>
          <p class="text-xs text-muted-foreground">Asks the process (pid {communicator.process?.pid ?? "?"}) to exit. Reported stopped only once it acknowledges and its connection closes. A client starts a new one when needed.</p>
        {:else}
          <p class="text-xs text-muted-foreground">This communicator did not announce that it can be stopped remotely, so only its connection can be closed from here.</p>
        {/if}
      </section>
    {/if}
  {:else if agent}
    <!-- ── an agent session ───────────────────────────────────────────────── -->
    <section class="space-y-3">
      <header class="flex flex-wrap items-center gap-2">
        {#if isEngine(agent.engine)}<EngineAvatar engine={agent.engine} presence={agent.presence as Presence} size="sm" logo />{/if}
        <h2 class="min-w-0 break-words text-base font-semibold">{agent.name}</h2>
        {#if ghost}<Badge variant="secondary">Ended</Badge>{:else}<Badge variant={presenceVariant(agent.presence)}>{agent.presence}</Badge>{/if}
      </header>

      <div class="rounded-md border p-3 text-sm">
        {#if agent.association.state === "unattributed"}
          <p class="font-medium">Direct</p>
          <p class="text-muted-foreground">No communicator has carried this session's requests recently, so it is shown on the server. It may talk to the server directly, or its communicator may have just reconnected — sessions reappear under it as they next speak, within about 15 s.</p>
        {:else if parent}
          <p class="font-medium">Carried by <button type="button" class="underline underline-offset-2" onclick={() => onselect(parent.id)}>{communicatorLabel(parent)}</button></p>
          <p class="text-muted-foreground">
            {agent.association.state === "attributed" ? "Its requests were last seen on that connection" : "Its requests have not been seen on that connection since"}
            {ageLabel(agent.association.age_s)}.
            {#if agent.association.also_seen_on.length > 0}Also seen on {agent.association.also_seen_on.length} other connection{agent.association.also_seen_on.length === 1 ? "" : "s"} during a redial.{/if}
          </p>
        {:else}
          <p class="font-medium">Carried by a communicator that has since disconnected</p>
        {/if}
      </div>

      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt class="text-muted-foreground">Engine</dt><dd>{isEngine(agent.engine) ? engineLabel(agent.engine) : agent.engine}</dd>
        <dt class="text-muted-foreground">Host</dt><dd class="break-words">{agent.host}</dd>
        <dt class="text-muted-foreground">OS user</dt><dd>{agent.username}</dd>
        {#if agent.address}<dt class="text-muted-foreground">Address</dt><dd class="break-all font-mono text-xs">{agent.address}</dd>{/if}
        <dt class="text-muted-foreground">Session</dt>
        <dd class="flex items-center gap-1 font-mono text-xs"><span title={agent.id}>{shortId(agent.id)}</span><CopyButton value={agent.id} variant="ghost" size="icon" class="h-6 w-6" aria-label="Copy session id" /></dd>
        {#if agent.binding_generation !== null}<dt class="text-muted-foreground">Binding</dt><dd>generation {agent.binding_generation}</dd>{/if}
        <dt class="text-muted-foreground">Kind</dt><dd>{agent.invocation_kind}{agent.daemon ? " · launched by host daemon" : ""}</dd>
        <dt class="text-muted-foreground">Directory</dt><dd class="break-all font-mono text-xs">{agent.cwd}</dd>
        <dt class="text-muted-foreground">Started</dt><dd>{when(agent.started_at)}</dd>
        <dt class="text-muted-foreground">Heartbeat</dt><dd>{ageLabel(agent.heartbeat_age_s)}</dd>
        {#if agent.close}<dt class="text-muted-foreground">Close request</dt><dd>{agent.close.state === "acknowledged" ? "acknowledged by the agent" : agent.close.state === "undeliverable" ? "could not be delivered" : "waiting for the agent"}</dd>{/if}
      </dl>
    </section>

    {#if !ghost}
      <section class="sticky bottom-0 mt-auto space-y-2 border-t bg-card pb-1 pt-3">
        <h3 class="section-label">Control</h3>
        <Button variant="outline" class="w-full justify-start" disabled={!canPortal || !agent.actions.request_close.allowed} onclick={() => begin("request_close", agent.id)}>Ask the agent to close…</Button>
        {#if !agent.actions.request_close.allowed}<p class="text-xs text-muted-foreground">{actionReason(agent.actions.request_close.reason)}</p>{/if}
        <Button variant="outline" class="w-full justify-start text-destructive" disabled={!canRemote || !agent.actions.stop_process.allowed} onclick={() => begin("stop_process", agent.id)}>Stop the process…</Button>
        {#if !agent.actions.stop_process.allowed}<p class="text-xs text-muted-foreground">{actionReason(agent.actions.stop_process.reason)}</p>{/if}
        <Button variant="outline" class="w-full justify-start text-destructive" disabled={!canPortal || !agent.actions.end_record.allowed} onclick={() => begin("end_record", agent.id)}>End the session record…</Button>
        <p class="text-xs text-muted-foreground">
          {#if !canPortal}Requires the agent-sessions management permission.{:else}Ending the record changes what the server believes; it does not signal the agent's process.{/if}
        </p>
      </section>
    {/if}
  {/if}
</div>

{#if action}
  {#if action.kind === "disconnect"}
    <ConfirmAction
      bind:open={dialogOpen}
      bind:note
      withNote
      title="Disconnect this communicator?"
      description="Closes the server connection of one communicator. This is a transport reset, not a shutdown."
      target={[
        { label: "Communicator", value: targetCommunicator ? communicatorLabel(targetCommunicator) : "—" },
        { label: "Host", value: targetCommunicator?.host ?? "—" },
        { label: "Version", value: targetCommunicator ? `cxx ${targetCommunicator.version}` : "—" },
        { label: "Connection", value: action.id },
      ]}
      affected={{
        heading: `Agents carried by this connection (${action.affected.length})`,
        items: action.affected,
        empty: "No session traffic has been seen on this connection.",
      }}
      effects={[
        "Only this connection closes. Other communicators and the server are unaffected.",
        "The communicator process keeps running and redials within 1–30 s. Agent sessions keep running.",
        "Requests in flight on this connection finish as “outcome unknown”; callers verify before retrying, so nothing is replayed.",
        "To stop a session itself, select that agent instead.",
      ]}
      confirmLabel="Disconnect"
      pendingLabel="Closing connection…"
      {phase}
      resultTitle={outcome?.title}
      {errorMessage}
      onconfirm={confirm}
      onclose={close}
    >
      {#snippet result()}
        {#each outcome?.lines ?? [] as line (line)}<p class="mt-1">{line}</p>{/each}
        <p class="mt-1">
          {@render successorNote(departure, true)}
        </p>
      {/snippet}
    </ConfirmAction>
  {:else if action.kind === "terminate"}
    <ConfirmAction
      bind:open={dialogOpen}
      bind:note
      withNote
      title="Stop this communicator's process?"
      description="Asks the communicator owner process itself to exit. It is reported stopped only when the process acknowledges and its connection closes."
      target={[
        { label: "Communicator", value: targetCommunicator ? communicatorLabel(targetCommunicator) : "—" },
        { label: "Host", value: targetCommunicator?.host ?? "—" },
        { label: "Process", value: targetCommunicator?.process ? `pid ${targetCommunicator.process.pid} (self-reported)` : "not reported" },
        { label: "Connection", value: action.id },
      ]}
      affected={{
        heading: `Agents carried by this connection (${action.affected.length})`,
        items: action.affected,
        empty: "No session traffic has been seen on this connection.",
      }}
      effects={[
        "Only this communicator process is asked to stop. Native agent sessions are not signalled and keep running.",
        "In-flight local requests get up to 3 s to finish; the rest come back as “outcome unknown” and are never replayed.",
        "A surviving client (or an attached host daemon) starts a new communicator on its next managed call.",
        "If the process does not answer, nothing is claimed: it is reported as unacknowledged.",
      ]}
      confirmLabel="Stop process"
      pendingLabel="Waiting for the process to acknowledge…"
      {phase}
      resultTitle={outcome?.title}
      resultTone={outcome?.tone}
      {errorMessage}
      onconfirm={confirm}
      onclose={close}
    >
      {#snippet result()}
        {#each outcome?.lines ?? [] as line (line)}<p class="mt-1">{line}</p>{/each}
        {#if outcome?.title === "Process stopped"}
          <p class="mt-1">
            {@render successorNote(departure, true)}
          </p>
        {/if}
      {/snippet}
    </ConfirmAction>
  {:else}
    <ConfirmAction
      bind:open={dialogOpen}
      bind:note
      withNote={action.kind !== "stop_process"}
      title={action.kind === "request_close" ? "Ask this agent to close?" : action.kind === "stop_process" ? "Stop this agent's process?" : "End this session's record?"}
      description={action.kind === "request_close"
        ? "Queues a close request for the agent to honour in its own time."
        : action.kind === "stop_process"
          ? "Asks the host daemon that launched this session to stop its process."
          : "Marks the session ended on the server, even if the agent can no longer be reached."}
      target={[
        { label: "Agent", value: targetAgent?.name ?? "—" },
        { label: "Engine", value: targetAgent ? (isEngine(targetAgent.engine) ? engineLabel(targetAgent.engine) : targetAgent.engine) : "—" },
        { label: "Host", value: targetAgent ? `${targetAgent.username}@${targetAgent.host}` : "—" },
        { label: "Session", value: action.id },
      ]}
      effects={action.kind === "request_close"
        ? [
            "The agent finishes its current turn, then sees the request. Nothing is interrupted.",
            "If it never listens again the request stays pending; use “End the session record” as the escalation.",
          ]
        : action.kind === "stop_process"
          ? [
              "Unstarted work for this session is cancelled; a running turn is stopped by the daemon.",
              "Only sessions launched by a host daemon can be stopped this way. The stop is recorded on the daemon session.",
            ]
          : [
              "The server stops treating the session as live straight away.",
              "The agent's process is not signalled. It stops being served and may keep running locally until it exits.",
            ]}
      confirmLabel={action.kind === "request_close" ? "Send close request" : action.kind === "stop_process" ? "Stop process" : "End record"}
      pendingLabel={action.kind === "request_close" ? "Sending…" : action.kind === "stop_process" ? "Stopping…" : "Ending…"}
      tone={action.kind === "request_close" ? "default" : "destructive"}
      {phase}
      resultTitle={outcome?.title}
      {errorMessage}
      onconfirm={confirm}
      onclose={close}
    >
      {#snippet result()}
        {#each outcome?.lines ?? [] as line (line)}<p class="mt-1">{line}</p>{/each}
        {#if action?.kind === "request_close" && liveAgent?.close}
          <p class="mt-1 font-medium">{liveAgent.close.state === "acknowledged" ? "The agent acknowledged it." : liveAgent.close.state === "undeliverable" ? "It could not be delivered." : "Waiting for the agent to pick it up…"}</p>
        {/if}
      {/snippet}
    </ConfirmAction>
  {/if}
{/if}

<style>
  .legend-dot { display: inline-block; height: 0.65rem; width: 0.65rem; margin-right: 0.35rem; border: 2px solid; border-radius: 9999px; vertical-align: -1px; }
</style>
