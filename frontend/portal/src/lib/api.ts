import type { Agent, CloseState, EventRow, PortalUser } from "$lib/portal/types";

export class ApiFailure extends Error {
  code?: string;
  status?: number;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Nothing here may hang forever. Without a deadline a stalled POST left
 * `sending` true for the life of the page: the send button stayed disabled and
 * a reload was the only way out.
 */
const REQUEST_TIMEOUT_MS = 20_000;

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, { ...init, headers, credentials: "same-origin", signal: controller.signal });
    // Headers arriving is not completion: keep the deadline through the body.
    const parsed: unknown = await response.json().catch((reason: unknown) => {
      if (controller.signal.aborted) throw reason;
      return null;
    });
    controller.signal.throwIfAborted();
    const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    if (!response.ok || body?.status === "error") {
      // statusText is empty under HTTP/2; retain a useful fallback.
      const message =
        (typeof body?.message === "string" && body.message.trim()) ||
        response.statusText.trim() ||
        `The portal returned an error (HTTP ${response.status}).`;
      throw new ApiFailure(message, typeof body?.code === "string" ? body.code : undefined, response.status);
    }
    if (!body) throw new ApiFailure("The portal did not confirm the response. Try again.", "portal_invalid_response");
    return ((body.status === "ok" && body.data) || body) as T;
  } catch (reason) {
    if (controller.signal.aborted || (reason as Error)?.name === "AbortError") {
      throw new ApiFailure("The portal did not respond in time. Try again.", "portal_timeout");
    }
    throw reason;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One bounded retry of an uncertain delivery keeps the exact serialized body.
 * Authorization, disabled policy and other definitive decisions do not retry.
 */
async function postWithStableRetry<T = Record<string, unknown>>(path: string, init: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api<T>(path, init);
    } catch (reason) {
      const failure = reason as ApiFailure;
      const transient = failure instanceof ApiFailure
        ? failure.code !== "agent_portal_disabled" && (["portal_timeout", "portal_invalid_response"].includes(failure.code ?? "")
          || [408, 429, 500, 502, 503, 504].includes(failure.status ?? 0))
        : reason instanceof TypeError;
      if (attempt >= 1 || !transient) throw reason;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const agentPath = (id: string) => `/go/api/agents/${encodeURIComponent(id)}`;

export const exchangeMagicLink = (publicId: string, token: string) =>
  api("/go/api/auth/exchange", json({ public_id: publicId, token }));

export interface PortalTimings {
  heartbeat_fresh_seconds: number;
  relay_fresh_seconds: number;
  working_fresh_seconds?: number;
  retention_hours: number;
}

/** Serves the freshness windows so the browser stops hardcoding them. */
export const fetchState = () =>
  api<{ enabled: boolean; timings?: PortalTimings }>("/go/api/state");

export const fetchMe = () => api<{ user: PortalUser }>("/go/api/me");

export const fetchAgents = () => api<{ agents: Agent[]; generated_at?: string }>("/go/api/agents");

export const fetchTail = (id: string, limit = 200) =>
  api<{ events: EventRow[] }>(`${agentPath(id)}/events?tail=1&limit=${limit}`);

/** Gap recovery appends rather than replacing, so scroll position survives. */
export const fetchSince = (id: string, after: number, limit = 500) =>
  api<{ events: EventRow[] }>(`${agentPath(id)}/events?after=${after}&limit=${limit}`);

export const sendMessage = (id: string, clientMessageId: string, content: string) =>
  postWithStableRetry(`${agentPath(id)}/messages`, json({ client_message_id: clientMessageId, content }));

export const answerPrompt = (id: string, promptId: string, clientMessageId: string, answer: string, version: number) =>
  postWithStableRetry(`${agentPath(id)}/prompts/${encodeURIComponent(promptId)}/answer`,
    json({ client_message_id: clientMessageId, answer, version }));

export interface CloseResponse {
  close_requested_at: string;
  close: { requested_at: string; state: CloseState };
}

export const closeAgent = (id: string, clientMessageId: string, note: string) =>
  postWithStableRetry<CloseResponse>(`${agentPath(id)}/close`, json({ client_message_id: clientMessageId, note }));

export interface ForceCloseResponse {
  forced: boolean;
  already_ended: boolean;
  status: string;
  ended_at: string | null;
  expires_at: string | null;
}

export const forceEndAgent = (id: string, clientMessageId: string, note: string) =>
  postWithStableRetry<ForceCloseResponse>(`${agentPath(id)}/close/force`,
    json({ client_message_id: clientMessageId, note }));

export const logout = () => api("/go/api/logout", { method: "POST", body: "{}" }).catch(() => undefined);

export const reconnectReceiver = (id: string) => api(`${agentPath(id)}/receiver/verify`, json({}));
