<script lang="ts">
  import { onMount } from "svelte";

  type PortalUser = { id: number; display_name: string };
  type Agent = {
    id: string;
    engine: "codex" | "claude";
    host: string;
    username: string;
    cwd: string;
    status: string;
    started_at: string;
    ended_at: string | null;
    read_only: boolean;
    relay_ready: boolean;
    pending_prompt: { id: string; question: string; options: string[]; version: number; created_at: string } | null;
  };
  type EventRow = {
    cursor: number;
    session_id: string;
    type: string;
    source: string;
    payload: Record<string, unknown>;
    created_at: string;
  };

  let phase = $state<"loading" | "ready" | "disabled" | "login" | "error">("loading");
  let user = $state<PortalUser | null>(null);
  let agents = $state<Agent[]>([]);
  let selectedId = $state("");
  let timeline = $state<EventRow[]>([]);
  let message = $state("");
  let sending = $state(false);
  let error = $state("");
  let connected = $state(false);
  let eventSource: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const selected = $derived(agents.find((agent) => agent.id === selectedId) ?? null);
  const activeAgents = $derived(agents.filter((agent) => !agent.ended_at));
  const recentAgents = $derived(agents.filter((agent) => Boolean(agent.ended_at)));

  onMount(() => {
    void bootstrap();
    return () => {
      eventSource?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  });

  async function bootstrap() {
    try {
      const token = new URLSearchParams(location.hash.slice(1)).get("t");
      const publicId = publicIdFromPath();
      if (token && publicId) {
        // Fragments are not sent to the server, but scrub the reusable secret
        // before any network wait so a failed exchange does not leave it in
        // browser history or a copied address bar.
        history.replaceState({}, document.title, location.pathname + location.search);
        await api("/go/api/auth/exchange", {
          method: "POST",
          body: JSON.stringify({ public_id: publicId, token }),
        });
      }
      const me = await api<{ user: PortalUser }>("/go/api/me");
      user = me.user;
      phase = "ready";
      await refreshAgents();
      connectEvents();
      pollTimer = setInterval(() => void refreshAgentsSafe(), 10_000);
    } catch (reason) {
      const apiError = reason as ApiFailure;
      if (apiError.code === "agent_portal_disabled") phase = "disabled";
      else if (
        ["agent_portal_login_required", "agent_portal_session_expired", "agent_portal_link_invalid"].includes(
          apiError.code ?? "",
        )
      ) phase = "login";
      else {
        error = apiError.message || "The agent portal could not be loaded.";
        phase = "error";
      }
    }
  }

  async function refreshAgents() {
    const result = await api<{ agents: Agent[] }>("/go/api/agents");
    agents = result.agents;
    if (!selectedId || !agents.some((agent) => agent.id === selectedId)) {
      selectedId = agents.find((agent) => !agent.ended_at)?.id ?? agents[0]?.id ?? "";
    }
    if (selectedId) await loadTimeline(selectedId);
  }

  async function selectAgent(id: string) {
    selectedId = id;
    timeline = [];
    await loadTimeline(id);
  }

  async function loadTimeline(id: string) {
    const result = await api<{ events: EventRow[] }>(
      `/go/api/agents/${encodeURIComponent(id)}/events?tail=1&limit=500`,
    );
    if (id === selectedId) timeline = result.events;
  }

  function connectEvents() {
    eventSource?.close();
    const stream = new EventSource("/go/api/events");
    eventSource = stream;
    stream.onopen = () => {
      connected = true;
      void refreshAgentsSafe();
    };
    stream.onerror = () => (connected = false);
    stream.addEventListener("agent", (raw) => {
      const incoming = JSON.parse((raw as MessageEvent).data) as EventRow;
      if (
        incoming.session_id === selectedId &&
        !timeline.some((event) => event.cursor === incoming.cursor)
      ) timeline = [...timeline, incoming];
      void refreshAgentsSafe();
    });
    stream.addEventListener("unavailable", (raw) => {
      connected = false;
      stream.close();
      let code = "stream_error";
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { code?: string };
        code = payload.code ?? code;
      } catch {
        // A malformed terminal event is treated as a transient stream error.
      }
      if (code === "agent_portal_disabled") phase = "disabled";
      else if (["agent_portal_login_required", "agent_portal_session_expired"].includes(code)) phase = "login";
      else {
        error = "The live event stream became unavailable.";
        phase = "error";
      }
    });
  }

  async function refreshAgentsSafe() {
    try {
      await refreshAgents();
    } catch (reason) {
      const apiError = reason as ApiFailure;
      if (apiError.code === "agent_portal_disabled") {
        eventSource?.close();
        phase = "disabled";
      } else if (["agent_portal_login_required", "agent_portal_session_expired"].includes(apiError.code ?? "")) {
        eventSource?.close();
        phase = "login";
      } else {
        connected = false;
        error = apiError.message || "The agent list could not be refreshed.";
      }
    }
  }

  async function sendMessage(answerPrompt = false, option?: string) {
    if (!selected || selected.read_only || !selected.relay_ready || sending) return;
    const content = (option ?? message).trim();
    if (!content) return;
    sending = true;
    error = "";
    try {
      const clientMessageId = crypto.randomUUID();
      if (answerPrompt && selected.pending_prompt) {
        await postWithStableRetry(`/go/api/agents/${selected.id}/prompts/${selected.pending_prompt.id}/answer`, {
          method: "POST",
          body: JSON.stringify({ client_message_id: clientMessageId, answer: content, version: selected.pending_prompt.version }),
        });
      } else {
        await postWithStableRetry(`/go/api/agents/${selected.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ client_message_id: clientMessageId, content }),
        });
      }
      message = "";
      await refreshAgents();
    } catch (reason) {
      const apiError = reason as ApiFailure;
      error =
        apiError.code === "already_answered"
          ? "Another user already answered this prompt."
          : apiError.message;
      await refreshAgents();
    } finally {
      sending = false;
    }
  }

  async function logout() {
    await api("/go/api/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    location.reload();
  }

  function publicIdFromPath(): string | null {
    const match = /^\/go\/u\/([^/]+)\/?$/.exec(location.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function eventText(event: EventRow): string {
    const payload = event.payload;
    if (typeof payload.text === "string") return payload.text;
    if (typeof payload.question === "string") return payload.question;
    if (typeof payload.summary === "string") return payload.summary;
    if (event.type === "message_accepted") return "Instruction accepted by the running agent.";
    return event.type.replaceAll("_", " ");
  }

  function eventRole(event: EventRow): string {
    if (event.type === "user_message") return "you";
    if (event.type === "assistant_message") return "agent";
    return "status";
  }

  function shortPath(path: string): string {
    const parts = path.split("/").filter(Boolean);
    return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
  }

  function formatTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  }

  class ApiFailure extends Error {
    code?: string;
    status?: number;
    constructor(message: string, code?: string, status?: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || body.status === "error") {
      throw new ApiFailure(
        typeof body.message === "string" ? body.message : response.statusText,
        typeof body.code === "string" ? body.code : undefined,
        response.status,
      );
    }
    return ((body.status === "ok" && body.data) || body) as T;
  }

  async function postWithStableRetry<T = Record<string, unknown>>(path: string, init: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await api<T>(path, init);
      } catch (reason) {
        const failure = reason as ApiFailure;
        if (attempt >= 1 || (failure instanceof ApiFailure && (failure.status ?? 0) < 500)) throw reason;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
</script>

{#if phase === "loading"}
  <main class="center-state"><div class="pulse"></div><p>Opening your fleet…</p></main>
{:else if phase === "disabled"}
  <main class="center-state"><div class="state-icon">○</div><h1>Agent portal is off</h1><p>The fleet administrator has disabled remote agent access. Local agents are unaffected.</p></main>
{:else if phase === "login"}
  <main class="center-state"><div class="state-icon">↗</div><h1>Open your Matrix link</h1><p>This browser has no active portal login. Use the permanent link sent to you in Matrix.</p></main>
{:else if phase === "error"}
  <main class="center-state"><div class="state-icon">!</div><h1>Portal unavailable</h1><p>{error}</p><button onclick={() => location.reload()}>Retry</button></main>
{:else}
  <div class="app-shell">
    <header>
      <div><span class="eyebrow">Fleet agents</span><h1>{user?.display_name}</h1></div>
      <div class="header-actions"><span class:online={connected} class="connection"><i></i>{connected ? "Live" : "Reconnecting"}</span><button class="ghost" onclick={logout}>Log out</button></div>
    </header>

    <nav class="agent-tabs" aria-label="Agent sessions">
      {#each activeAgents as agent}
        <button class:active={agent.id === selectedId} onclick={() => selectAgent(agent.id)}>
          <span class="engine {agent.engine}">{agent.engine === "codex" ? "CX" : "CL"}</span>
          <span><strong>{agent.host}</strong><small>{shortPath(agent.cwd)}</small></span>
          <i class="status-dot {agent.status}"></i>
        </button>
      {/each}
      {#each recentAgents as agent}
        <button class:active={agent.id === selectedId} class="finished" onclick={() => selectAgent(agent.id)}>
          <span class="engine {agent.engine}">{agent.engine === "codex" ? "CX" : "CL"}</span>
          <span><strong>{agent.host}</strong><small>Recently finished</small></span>
        </button>
      {/each}
    </nav>

    {#if selected}
      <section class="session-bar">
        <div><strong>{selected.engine === "codex" ? "Codex" : "Claude"}</strong><span>{selected.username}@{selected.host}</span></div>
        <div class="session-meta"><span title={selected.cwd}>{shortPath(selected.cwd)}</span><span class="status-pill {selected.status}">{selected.status}</span></div>
      </section>

      <main class="timeline" aria-live="polite">
        {#if timeline.length === 0}<div class="empty"><span>⌁</span><p>No visible messages yet.</p></div>{/if}
        {#each timeline as event (event.cursor)}
          <article class="event {eventRole(event)}">
            {#if eventRole(event) === "status"}<span class="event-label">{event.type.replaceAll("_", " ")}</span>{/if}
            <p>{eventText(event)}</p>
            <time>{formatTime(event.created_at)}</time>
          </article>
        {/each}
      </main>

      <footer>
        {#if selected.pending_prompt && !selected.read_only && selected.relay_ready}
          <div class="prompt-card">
            <span>Agent asks</span><strong>{selected.pending_prompt.question}</strong>
            {#if selected.pending_prompt.options.length}
              <div class="options">{#each selected.pending_prompt.options as option}<button onclick={() => sendMessage(true, option)}>{option}</button>{/each}</div>
            {/if}
          </div>
        {/if}
        {#if error}<div class="inline-error">{error}</div>{/if}
        {#if selected.read_only}
          <div class="read-only">This session is finished and remains readable for 24 hours.</div>
        {:else if !selected.relay_ready}
          <div class="read-only">This agent is visible but is not accepting remote instructions. Run <code>#afk</code> in the local agent session to open the relay.</div>
        {:else}
          <form onsubmit={(event) => { event.preventDefault(); void sendMessage(Boolean(selected?.pending_prompt)); }}>
            <textarea bind:value={message} rows="1" maxlength="32768" placeholder={selected.pending_prompt ? "Answer the agent…" : "Instruct the running agent…"} onkeydown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(Boolean(selected?.pending_prompt)); } }}></textarea>
            <button class="send" disabled={sending || !message.trim()} aria-label="Send">{sending ? "…" : "↑"}</button>
          </form>
          <small class="authority">Text only · local sandbox and approvals still apply</small>
        {/if}
      </footer>
    {:else}
      <main class="center-state inner"><div class="state-icon">◇</div><h2>No active agents</h2><p>Human-started Codex and Claude sessions will appear here automatically.</p></main>
    {/if}
  </div>
{/if}
