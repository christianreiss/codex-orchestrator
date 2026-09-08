/**
 * Auto-reconnecting admin WebSocket client.
 *
 * Discovers the URL + heartbeat interval + lastEventId from
 * `GET /admin/ws/info`, opens the socket, reconnects with exponential
 * backoff (1s → 30s, ±25% jitter clamped so no wait exceeds 30s), and
 * emits typed `WsEvent`s on a Svelte writable.
 */
import { writable, type Readable } from "svelte/store";
import { api } from "../api/client";

export interface WsInfo {
  enabled: boolean;
  url?: string;
  heartbeat_seconds?: number;
  last_event_id?: number | string | null;
  token?: string | null;
}

/** One frame as `api/src/ws/publisher.ts` writes it. */
export interface WsEvent<P = unknown> {
  type: string;
  payload: P;
  ts: string;
}

interface InternalState {
  socket: WebSocket | null;
  attempts: number;
  lastEventId: number | string | null;
  stopped: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  enabled: boolean;
  generation: number;
  discovery: AbortController | null;
  connectionTimer: ReturnType<typeof setTimeout> | null;
  lastReceivedAt: number;
  heartbeatMs: number;
}

export interface WsClientHandle {
  events: Readable<WsEvent | null>;
  status: Readable<"idle" | "connecting" | "open" | "closed" | "disabled">;
  stop: () => void;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

export function backoffMs(attempt: number): number {
  const ms = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * Math.pow(2, attempt));
  return Math.min(RECONNECT_MAX_MS, Math.round(ms * (0.75 + Math.random() * 0.5)));
}

export function createWsClient(): WsClientHandle {
  const events = writable<WsEvent | null>(null);
  const status = writable<"idle" | "connecting" | "open" | "closed" | "disabled">("idle");

  const state: InternalState = {
    socket: null,
    attempts: 0,
    lastEventId: null,
    stopped: false,
    reconnectTimer: null,
    heartbeatTimer: null,
    enabled: true,
    generation: 0,
    discovery: null,
    connectionTimer: null,
    lastReceivedAt: 0,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
  };

  function clearTimers() {
    if (state.reconnectTimer !== null) clearTimeout(state.reconnectTimer);
    if (state.connectionTimer !== null) clearTimeout(state.connectionTimer);
    if (state.heartbeatTimer !== null) clearInterval(state.heartbeatTimer);
    state.reconnectTimer = state.connectionTimer = state.heartbeatTimer = null;
  }

  function scheduleReconnect() {
    if (state.stopped || !state.enabled || state.reconnectTimer !== null) return;
    const delay = backoffMs(state.attempts);
    state.attempts = Math.min(state.attempts + 1, 12);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      void connect();
    }, delay);
  }

  function current(generation: number, socket?: WebSocket): boolean {
    return !state.stopped && state.generation === generation && (!socket || state.socket === socket);
  }

  // Fence late events before closing: a browser may deliver error, close, and
  // even an already queued open callback from the retired socket afterwards.
  function disconnect(generation: number, retry = true) {
    if (!current(generation)) return;
    state.generation += 1;
    const old = state.socket;
    state.socket = null;
    clearTimers();
    state.discovery?.abort();
    state.discovery = null;
    try { old?.close(); } catch { /* already gone */ }
    status.set("closed");
    if (retry) scheduleReconnect();
  }

  async function connect() {
    if (state.stopped || !state.enabled) return;
    const generation = ++state.generation;
    const controller = new AbortController();
    state.discovery = controller;
    status.set("connecting");
    // A silent fetch or incomplete WebSocket handshake must not leave the
    // toolbar claiming Connecting forever, even when no error event arrives.
    state.connectionTimer = setTimeout(() => disconnect(generation), CONNECT_TIMEOUT_MS);
    let info: WsInfo;
    try {
      info = await api.get<WsInfo>("/admin/ws/info", { signal: controller.signal });
    } catch {
      disconnect(generation);
      return;
    }
    if (!current(generation)) return;
    state.discovery = null;
    if (state.connectionTimer !== null) clearTimeout(state.connectionTimer);
    state.connectionTimer = null;
    if (!info || typeof info !== "object" || Array.isArray(info)) {
      disconnect(generation);
      return;
    }
    if (info.enabled === false) {
      state.enabled = false;
      status.set("disabled");
      return;
    }
    if (info.enabled !== true || typeof info.url !== "string" || !info.url.trim()) {
      disconnect(generation);
      return;
    }
    state.lastEventId = info.last_event_id ?? state.lastEventId ?? null;
    const seconds = info.heartbeat_seconds;
    state.heartbeatMs = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? Math.max(5, seconds) * 1_000 : DEFAULT_HEARTBEAT_MS;

    let url = info.url.trim();
    if (state.lastEventId !== null && state.lastEventId !== "") {
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}last_event_id=${encodeURIComponent(String(state.lastEventId))}`;
    }

    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch { disconnect(generation); return; }
    state.socket = ws;
    state.connectionTimer = setTimeout(() => disconnect(generation), CONNECT_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      if (!current(generation, ws)) return;
      if (state.connectionTimer !== null) clearTimeout(state.connectionTimer);
      state.connectionTimer = null;
      state.attempts = 0;
      state.lastReceivedAt = Date.now();
      status.set("open");
      // The server's WS bus has no durable replay cursor. Refresh the clients
      // snapshot on every connection instead of assuming missed frames replay.
      events.set({ type: "transport.connected", payload: {}, ts: new Date().toISOString() });
      state.heartbeatTimer = setInterval(() => {
        if (!current(generation, ws)) return;
        if (Date.now() - state.lastReceivedAt >= state.heartbeatMs * 3 || ws.readyState !== WebSocket.OPEN) {
          disconnect(generation);
          return;
        }
        try { ws.send(JSON.stringify({ type: "ping" })); }
        catch { disconnect(generation); }
      }, state.heartbeatMs);
    });

    ws.addEventListener("message", (msg) => {
      if (!current(generation, ws)) return;
      let frame: WsEvent | null;
      try { frame = JSON.parse(typeof msg.data === "string" ? msg.data : ""); }
      catch { return; }
      if (!frame || typeof frame !== "object" || typeof frame.type !== "string" || !frame.type) return;
      state.lastReceivedAt = Date.now();
      events.set(frame);
    });
    ws.addEventListener("close", () => disconnect(generation));
    ws.addEventListener("error", () => disconnect(generation));
  }

  // Browsers can suspend timers while a laptop sleeps. On return, discard a
  // silent connection immediately; a healthy socket and its observers stay put.
  const browserWindow = typeof window === "undefined" ? null : window;
  const browserDocument = typeof document === "undefined" ? null : document;
  function wake() {
    if (state.stopped || !state.enabled) return;
    if (state.socket?.readyState === WebSocket.OPEN && Date.now() - state.lastReceivedAt < state.heartbeatMs * 2) return;
    disconnect(state.generation, false);
    void connect();
  }
  function visibilityChanged() {
    if (browserDocument?.visibilityState === "visible") wake();
  }
  browserWindow?.addEventListener?.("online", wake);
  browserDocument?.addEventListener?.("visibilitychange", visibilityChanged);

  // Defer connect to next tick to allow callers to subscribe first.
  if (typeof window !== "undefined") {
    queueMicrotask(() => {
      void connect();
    });
  }

  return {
    events: { subscribe: events.subscribe },
    status: { subscribe: status.subscribe },
    stop() {
      if (state.stopped) return;
      disconnect(state.generation, false);
      state.stopped = true;
      browserWindow?.removeEventListener?.("online", wake);
      browserDocument?.removeEventListener?.("visibilitychange", visibilityChanged);
      status.set("closed");
    },
  };
}
