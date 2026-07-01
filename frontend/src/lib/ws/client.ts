/**
 * Auto-reconnecting admin WebSocket client.
 *
 * Discovers the URL + heartbeat interval + lastEventId from
 * `GET /admin/ws/info`, opens the socket, reconnects with exponential
 * backoff (1s → 30s cap), and emits typed `WsEvent`s on a Svelte writable.
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

export interface WsEvent<T = unknown> {
  type: string;
  data?: T;
  id?: number | string;
  ts?: string;
}

interface InternalState {
  socket: WebSocket | null;
  attempts: number;
  lastEventId: number | string | null;
  stopped: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  enabled: boolean;
}

export interface WsClientHandle {
  events: Readable<WsEvent | null>;
  status: Readable<"idle" | "connecting" | "open" | "closed" | "disabled">;
  stop: () => void;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function backoffMs(attempt: number): number {
  const ms = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * Math.pow(2, attempt));
  return Math.round(ms * (0.75 + Math.random() * 0.5));
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
  };

  function clearTimers() {
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.heartbeatTimer !== null) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (state.stopped || !state.enabled) return;
    const delay = backoffMs(state.attempts);
    state.attempts = Math.min(state.attempts + 1, 12);
    state.reconnectTimer = setTimeout(connect, delay);
  }

  async function connect() {
    if (state.stopped) return;
    status.set("connecting");
    let info: WsInfo;
    try {
      info = await api.get<WsInfo>("/admin/ws/info");
    } catch {
      scheduleReconnect();
      return;
    }
    if (state.stopped) return;
    if (info.enabled === false || !info.url) {
      state.enabled = false;
      status.set("disabled");
      return;
    }
    state.enabled = true;
    state.lastEventId = info.last_event_id ?? state.lastEventId ?? null;

    let url = info.url;
    if (state.lastEventId !== null && state.lastEventId !== undefined && state.lastEventId !== "") {
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}last_event_id=${encodeURIComponent(String(state.lastEventId))}`;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    state.socket = ws;

    ws.addEventListener("open", () => {
      state.attempts = 0;
      status.set("open");
      if (info.heartbeat_seconds && info.heartbeat_seconds > 0) {
        state.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "ping" }));
            } catch {
              /* ignore */
            }
          }
        }, info.heartbeat_seconds * 1_000);
      }
    });

    ws.addEventListener("message", (msg) => {
      let payload: WsEvent | null = null;
      try {
        payload = JSON.parse(typeof msg.data === "string" ? msg.data : "");
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object" || !payload.type) return;
      if (payload.id !== undefined && payload.id !== null) state.lastEventId = payload.id;
      events.set(payload);
    });

    const closeHandler = () => {
      clearTimers();
      state.socket = null;
      if (!state.stopped) {
        status.set("closed");
        scheduleReconnect();
      }
    };
    ws.addEventListener("close", closeHandler);
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

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
      state.stopped = true;
      clearTimers();
      try {
        state.socket?.close();
      } catch {
        /* ignore */
      }
      state.socket = null;
      status.set("closed");
    },
  };
}
