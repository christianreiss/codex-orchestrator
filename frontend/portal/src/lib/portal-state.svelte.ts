import type { Agent, EventRow, Phase, PortalUser } from "$lib/portal/types";
import { livePresence, setHeartbeatFreshMs } from "$lib/portal/presence";
import { notable, parseReadRecord, pruneReadRecord, PREFS_KEY, READ_KEY, shouldAdvanceRead, type ReadRecord } from "$lib/portal/unread";
import { optimisticEvent, reconcileOptimistic } from "$lib/portal/delivery";
import {
  announcementFor,
  closeOutcome,
  closeReasonFor,
  describeFailure as describeFailureText,
  sendFailureMessage,
  threadHash,
  threadIdFromHash,
} from "$lib/portal/outcomes";
import * as api from "./api";
import { ApiFailure } from "./api";
import { notify } from "$lib/portal/browser";

/** Only these can change server-derived agent state, so only these refetch. */
const AGENT_STATE_EVENTS = new Set([
  "attention", "waiting_input", "close_requested", "message_canceled",
  "completed", "failed", "message_accepted", "started", "resumed",
]);

const AGENTS_DEBOUNCE_MS = 600;
/**
 * Presence is 45s-granular server-side and the client downgrades a stale
 * heartbeat on its own, so a 10s poll bought nothing.
 */
const POLL_MS = 20_000;
const TICK_MS = 10_000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000];

interface Prefs {
  notify: boolean;
  endedOpen: boolean;
  selectedId: string;
}

export function createPortal() {
  let phase = $state<Phase>("loading");
  let user = $state<PortalUser | null>(null);
  let agents = $state<Agent[]>([]);
  let selectedId = $state("");
  let timeline = $state<EventRow[]>([]);
  let error = $state("");
  let connected = $state(false);
  let sending = $state(false);
  let closing = $state(false);
  /**
   * Lives here rather than inside Composer so it survives the component being
   * swapped out. A presence flip used to destroy whatever was being typed.
   */
  let draft = $state("");
  /** Why the close dialog reopened in force mode, if it did. */
  let closeReason = $state("");
  /** The single polite live region's text. */
  let announcement = $state("");
  /** Ticks so "waiting 4m" and the stale-heartbeat downgrade stay truthful. */
  let now = $state(Date.now());
  let atBottom = $state(true);
  let missed = $state(0);
  let readRecord = $state<ReadRecord>({});
  let unreadCounts = $state<Record<string, number>>({});
  let prefs = $state<Prefs>({ notify: false, endedOpen: false, selectedId: "" });

  let stream: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let agentsDebounce: ReturnType<typeof setTimeout> | null = null;
  let readWriteTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let scrollToBottom: ((smooth: boolean) => void) | null = null;

  const selected = $derived(agents.find((agent) => agent.id === selectedId) ?? null);
  const needsYou = $derived(agents.filter((agent) => agent.attention).length);
  const unreadTotal = $derived(
    agents.reduce((sum, agent) => sum + (agent.id === selectedId ? 0 : (unreadCounts[agent.id] ?? 0)), 0),
  );

  /* ── persistence ───────────────────────────────────────────────────────── */

  function loadStorage(): void {
    readRecord = parseReadRecord(localStorage.getItem(READ_KEY));
    try {
      prefs = { ...prefs, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>) };
    } catch {
      // A corrupt preference blob must not stop the portal from opening.
    }
  }

  function persistRead(): void {
    if (readWriteTimer) clearTimeout(readWriteTimer);
    readWriteTimer = setTimeout(() => {
      localStorage.setItem(READ_KEY, JSON.stringify(readRecord));
    }, 500);
  }

  function persistPrefs(): void {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }

  function markRead(id: string, cursor: number): void {
    const seen = readRecord[id];
    if (seen && seen.cursor >= cursor) return;
    readRecord = { ...readRecord, [id]: { cursor, at: new Date().toISOString() } };
    unreadCounts = { ...unreadCounts, [id]: 0 };
    persistRead();
  }

  function markSelectedRead(): void {
    const newest = timeline.at(-1);
    if (selectedId && newest && newest.cursor > 0) markRead(selectedId, newest.cursor);
  }

  function markAllRead(): void {
    const stamp = new Date().toISOString();
    const next: ReadRecord = { ...readRecord };
    for (const agent of agents) {
      next[agent.id] = { cursor: readRecord[agent.id]?.cursor ?? 0, at: stamp };
    }
    readRecord = next;
    unreadCounts = {};
    persistRead();
  }

  /* ── loading ───────────────────────────────────────────────────────────── */

  async function refreshAgents(): Promise<void> {
    const result = await api.fetchAgents();
    agents = result.agents;
    readRecord = pruneReadRecord(readRecord, agents.map((agent) => agent.id));
    if (!selectedId || !agents.some((agent) => agent.id === selectedId)) {
      // A URL is an explicit request and outranks the remembered preference.
      const linked = agents.find((agent) => agent.id === threadFromHash());
      const preferred = agents.find((agent) => agent.id === prefs.selectedId);
      const firstLive = agents.find((agent) => agent.presence !== "ended");
      selectedId = linked?.id ?? preferred?.id ?? firstLive?.id ?? agents[0]?.id ?? "";
      if (selectedId) writeThreadHash(selectedId);
    }
  }

  async function refreshAgentsSafe(): Promise<void> {
    try {
      await refreshAgents();
    } catch (reason) {
      applyFailure(reason as ApiFailure, "The agent list could not be refreshed.");
    }
  }

  function scheduleAgentsRefresh(): void {
    if (agentsDebounce) return;
    agentsDebounce = setTimeout(() => {
      agentsDebounce = null;
      void refreshAgentsSafe();
    }, AGENTS_DEBOUNCE_MS);
  }

  async function loadTimeline(id: string): Promise<void> {
    const result = await api.fetchTail(id);
    if (id !== selectedId) return;
    timeline = result.events;
    missed = 0;
    atBottom = true;
    queueMicrotask(() => scrollToBottom?.(false));
    markSelectedRead();
  }

  /** Appends rather than replacing, so scroll position and expansion survive. */
  async function recoverGap(): Promise<void> {
    if (!selectedId) return;
    const newest = timeline.filter((row) => row.cursor > 0).at(-1);
    if (!newest) return await loadTimeline(selectedId);
    const result = await api.fetchSince(selectedId, newest.cursor);
    for (const row of result.events) ingest(row, false);
  }

  async function select(id: string): Promise<void> {
    if (id === selectedId) return;
    selectedId = id;
    timeline = [];
    // Per-thread, so switching conversations does not carry an unsent reply to
    // the wrong agent.
    draft = "";
    writeThreadHash(id);
    prefs = { ...prefs, selectedId: id };
    persistPrefs();
    unreadCounts = { ...unreadCounts, [id]: 0 };
    await loadTimeline(id);
  }

  /* ── live events ───────────────────────────────────────────────────────── */

  /**
   * The single append path.
   *
   * The old code called a full agents refresh from here, and that refresh
   * ended by refetching the whole 500-event timeline -- so one SSE frame cost
   * a complete decrypt-and-transfer of the thread, rebuilt the list, and threw
   * away scroll position. The frame already carries the event, so nothing here
   * fetches; only agent-state-changing types schedule a debounced list refresh.
   */
  function ingest(event: EventRow, live = true): void {
    const agent = agents.find((candidate) => candidate.id === event.session_id);
    if (agent) agent.last_event_at = event.created_at;

    if (event.session_id === selectedId) {
      if (!timeline.some((row) => row.cursor === event.cursor)) {
        timeline = [...reconcileOptimistic(timeline, event), event];
      }
      if (atBottom) {
        queueMicrotask(() => scrollToBottom?.(true));
        if (shouldAdvanceRead({ isSelected: true, documentVisible: document.visibilityState === "visible", atBottom: true })) {
          markRead(selectedId, event.cursor);
        }
      } else if (notable(event)) {
        missed += 1;
      }
    } else if (notable(event)) {
      unreadCounts = { ...unreadCounts, [event.session_id]: (unreadCounts[event.session_id] ?? 0) + 1 };
    }

    if (live && notable(event)) {
      const label = agent ? `${agent.engine === "codex" ? "Codex" : "Claude"} · ${agent.host}` : "Fleet agents";
      if (prefs.notify) notify(event, label, () => void select(event.session_id), Date.now());
      // Announced rather than only drawn: a timeline that grows in place tells
      // a screen reader nothing.
      announcement = announcementFor(event.type, label);
    }
    if (AGENT_STATE_EVENTS.has(event.type)) scheduleAgentsRefresh();
  }

  function connect(): void {
    stream?.close();
    const source = new EventSource("/go/api/events");
    stream = source;

    source.onopen = () => {
      connected = true;
      reconnectAttempt = 0;
      // The server starts a fresh stream at the newest cursor, so anything that
      // happened between page load and this moment was never delivered.
      void (async () => {
        await refreshAgentsSafe();
        await recoverGap().catch(() => undefined);
      })();
    };

    source.addEventListener("agent", (raw) => {
      try {
        ingest(JSON.parse((raw as MessageEvent).data) as EventRow);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    });

    source.addEventListener("unavailable", (raw) => {
      connected = false;
      source.close();
      stream = null;
      let code = "stream_error";
      try {
        code = (JSON.parse((raw as MessageEvent).data) as { code?: string }).code ?? code;
      } catch {
        // Treat a malformed terminal frame as a generic stream error.
      }
      if (code === "agent_portal_disabled") phase = "disabled";
      else if (["agent_portal_login_required", "agent_portal_session_expired"].includes(code)) phase = "login";
      else {
        error = "The live event stream became unavailable.";
        phase = "error";
      }
    });

    // EventSource retries on its own, but not once it has given up entirely.
    source.onerror = () => {
      connected = false;
      if (source.readyState !== EventSource.CLOSED || reconnectTimer) return;
      const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!;
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };
  }

  /* ── writes ────────────────────────────────────────────────────────────── */

  const describeFailure = (failure: ApiFailure, fallback: string): string =>
    describeFailureText(failure, fallback, failure instanceof ApiFailure);

  function applyFailure(failure: ApiFailure, fallback: string): void {
    if (failure.code === "agent_portal_disabled") {
      stream?.close();
      phase = "disabled";
    } else if (["agent_portal_login_required", "agent_portal_session_expired"].includes(failure.code ?? "")) {
      stream?.close();
      phase = "login";
    } else {
      error = describeFailure(failure, fallback);
    }
  }

  async function send(text: string): Promise<boolean> {
    const agent = selected;
    const content = text.trim();
    if (!agent || sending || !content) return false;
    sending = true;
    error = "";
    const clientMessageId = crypto.randomUUID();
    const placeholder = optimisticEvent(agent.id, clientMessageId, content, new Date().toISOString());
    timeline = [...timeline, placeholder];
    queueMicrotask(() => scrollToBottom?.(true));
    try {
      if (agent.pending_prompt) {
        await api.answerPrompt(agent.id, agent.pending_prompt.id, clientMessageId, content, agent.pending_prompt.version);
      } else {
        await api.sendMessage(agent.id, clientMessageId, content);
      }
      markSelectedRead();
      draft = "";
      return true;
    } catch (reason) {
      const failure = reason as ApiFailure;
      timeline = timeline.filter((row) => row !== placeholder);
      // Hand the text back. Losing the bubble AND the textarea left the
      // operator with a banner and nothing to retry, so the only recovery was
      // retyping from memory.
      draft = content;
      error = sendFailureMessage(failure, failure instanceof ApiFailure);
      announcement = "Message not sent.";
      return false;
    } finally {
      sending = false;
      await refreshAgentsSafe();
    }
  }

  /**
   * Resolves to "unreachable" when the agent cannot take a cooperative close,
   * so the caller can escalate instead of dead-ending on an error banner.
   */
  async function requestClose(note: string): Promise<"closed" | "unreachable" | "failed"> {
    const agent = selected;
    if (!agent || closing) return "failed";
    closing = true;
    error = "";
    closeReason = "";
    try {
      const result = await api.closeAgent(agent.id, crypto.randomUUID(), note);
      // Applied from the response so the closing bar appears immediately
      // instead of waiting out the debounced refresh.
      agent.close_requested_at = result.close_requested_at;
      agent.close = result.close;
      return "closed";
    } catch (reason) {
      const failure = reason as ApiFailure;
      if (closeOutcome(failure) === "unreachable") {
        closeReason = closeReasonFor(failure);
        return "unreachable";
      }
      applyFailure(failure, "The close request could not be sent.");
      return "failed";
    } finally {
      closing = false;
      await refreshAgentsSafe();
    }
  }

  async function forceEnd(note: string): Promise<void> {
    const agent = selected;
    if (!agent || closing) return;
    closing = true;
    error = "";
    try {
      const result = await api.forceEndAgent(agent.id, crypto.randomUUID(), note);
      if (result.ended_at) {
        agent.ended_at = result.ended_at;
        agent.presence = "ended";
        agent.read_only = true;
      }
    } catch (reason) {
      applyFailure(reason as ApiFailure, "The session could not be ended.");
    } finally {
      closing = false;
      await refreshAgentsSafe();
    }
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  function onVisibility(): void {
    if (document.visibilityState !== "visible") return;
    void refreshAgentsSafe();
    if (atBottom) markSelectedRead();
  }

  const threadFromHash = () => threadIdFromHash(location.hash);

  function writeThreadHash(id: string): void {
    const next = threadHash(id) || location.pathname + location.search;
    if (location.hash === next) return;
    history.replaceState(history.state, "", next);
  }

  async function bootstrap(): Promise<void> {
    loadStorage();
    try {
      // Served rather than duplicated: the browser ages a stale heartbeat
      // itself, and it used to do that against a literal typed on both sides.
      try {
        const state = await api.fetchState();
        setHeartbeatFreshMs(state.timings?.heartbeat_fresh_seconds);
      } catch {
        // Non-fatal: the built-in fallback window is still correct by default.
      }
      const token = new URLSearchParams(location.hash.slice(1)).get("t");
      const match = /^\/go\/u\/([^/]+)\/?$/.exec(location.pathname);
      const publicId = match ? decodeURIComponent(match[1]!) : null;
      if (token && publicId) {
        // Fragments never reach the server, but the token is reusable bearer
        // material -- scrub it before any await so a failed exchange cannot
        // leave it in history or a copied address bar.
        history.replaceState({}, document.title, location.pathname + location.search);
        await api.exchangeMagicLink(publicId, token);
      }
      user = (await api.fetchMe()).user;
      phase = "ready";
      await refreshAgents();
      if (selectedId) await loadTimeline(selectedId);
      connect();
      pollTimer = setInterval(() => {
        if (document.visibilityState === "visible") void refreshAgentsSafe();
      }, POLL_MS);
      tickTimer = setInterval(() => (now = Date.now()), TICK_MS);
      document.addEventListener("visibilitychange", onVisibility);
    } catch (reason) {
      const failure = reason as ApiFailure;
      if (failure.code === "agent_portal_disabled") phase = "disabled";
      else if (["agent_portal_login_required", "agent_portal_session_expired", "agent_portal_link_invalid"].includes(failure.code ?? "")) {
        phase = "login";
      } else {
        error = failure.message || "The agent portal could not be loaded.";
        phase = "error";
      }
    }
  }

  function teardown(): void {
    stream?.close();
    for (const timer of [pollTimer, tickTimer]) if (timer) clearInterval(timer);
    for (const timer of [agentsDebounce, readWriteTimer, reconnectTimer]) if (timer) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  return {
    get phase() { return phase; },
    get user() { return user; },
    get agents() { return agents; },
    get selected() { return selected; },
    get selectedId() { return selectedId; },
    get timeline() { return timeline; },
    get error() { return error; },
    get connected() { return connected; },
    get sending() { return sending; },
    get closing() { return closing; },
    get draft() { return draft; },
    set draft(value: string) { draft = value; },
    get closeReason() { return closeReason; },
    get announcement() { return announcement; },
    get now() { return now; },
    get atBottom() { return atBottom; },
    get missed() { return missed; },
    get readRecord() { return readRecord; },
    get unreadCounts() { return unreadCounts; },
    get needsYou() { return needsYou; },
    get unreadTotal() { return unreadTotal; },
    get prefs() { return prefs; },
    get livePresenceOf() { return (agent: Agent) => livePresence(agent, now); },

    setPrefs(patch: Partial<Prefs>) { prefs = { ...prefs, ...patch }; persistPrefs(); },
    setScroller(fn: (smooth: boolean) => void) { scrollToBottom = fn; },
    setAtBottom(value: boolean) {
      atBottom = value;
      if (value) { missed = 0; if (document.visibilityState === "visible") markSelectedRead(); }
    },
    clearError() { error = ""; },
    retry() { location.reload(); },
    async logout() { await api.logout(); location.reload(); },
    markAllRead,
    select,
    send,
    requestClose,
    forceEnd,
    bootstrap,
    teardown,
  };
}

export type Portal = ReturnType<typeof createPortal>;
