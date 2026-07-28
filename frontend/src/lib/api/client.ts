/**
 * Generic typed API client.
 *
 * Translates the three envelope shapes the codex-orchestrator backend
 * actually returns into a single `ApiError` for non-2xx responses, and
 * unwraps `{status: "ok", data: ...}` envelopes into bare `T`.
 *
 *   - Admin / host routes:    {status: "ok", data: ...}  |  {status: "error", message, code?}
 *   - OpenAI controllers:     {error: {message, type, code}}
 *   - Anthropic controllers:  {type: "error", error: {message, type, code}}
 */

export class ApiError extends Error {
  status: number;
  code?: string;
  body?: unknown;
  constructor(opts: { status: number; message: string; code?: string; body?: unknown }) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** Skip JSON serialization & content-type header on the body. */
  rawBody?: boolean;
  /** Disable JSON unwrapping; return the raw response body. */
  raw?: boolean;
}

/** Passes absolute URLs through; gives any other path a leading slash. */
function buildUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!path.startsWith("/")) path = "/" + path;
  return path;
}

/**
 * Extract a message from any of the three known error envelope shapes.
 * Falls back to HTTP status text.
 */
function extractErrorMessage(body: unknown, status: number, statusText: string): { message: string; code?: string } {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    // Admin envelope: {status: "error", message, code?}
    if (obj.status === "error" && typeof obj.message === "string") {
      return { message: obj.message, code: typeof obj.code === "string" ? obj.code : undefined };
    }
    // Anthropic envelope: {type: "error", error: {...}}
    if (obj.type === "error" && obj.error && typeof obj.error === "object") {
      const err = obj.error as Record<string, unknown>;
      return {
        message: typeof err.message === "string" ? err.message : statusText,
        code: typeof err.code === "string" ? err.code : typeof err.type === "string" ? err.type : undefined,
      };
    }
    // OpenAI envelope: {error: {...}}
    if (obj.error && typeof obj.error === "object") {
      const err = obj.error as Record<string, unknown>;
      return {
        message: typeof err.message === "string" ? err.message : statusText,
        code: typeof err.code === "string" ? err.code : typeof err.type === "string" ? err.type : undefined,
      };
    }
    if (typeof obj.message === "string") {
      return { message: obj.message, code: typeof obj.code === "string" ? obj.code : undefined };
    }
  }
  return { message: statusText || `HTTP ${status}` };
}

/** Unwrap the {status: "ok", data: ...} envelope when present. */
function unwrapOk<T>(body: unknown): T {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (obj.status === "ok" && "data" in obj) {
      return obj.data as T;
    }
  }
  return body as T;
}

export async function apiFetch<T = unknown>(path: string, init: ApiFetchOptions = {}): Promise<T> {
  const url = buildUrl(path);
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  let body: BodyInit | undefined;
  const method = (init.method ?? "GET").toUpperCase();
  if (init.body !== undefined && init.body !== null) {
    if (init.rawBody) {
      body = init.body as BodyInit;
    } else {
      body = JSON.stringify(init.body);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
  }

  const response = await fetch(url, {
    ...init,
    method,
    headers,
    body,
    credentials: init.credentials ?? "same-origin",
  });

  // No content / 204
  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  let parsed: unknown = undefined;
  if (contentType.includes("application/json")) {
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
  } else if (init.raw) {
    parsed = await response.text();
  } else {
    // Try JSON anyway; tolerate plain text
    const text = await response.text();
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const { message, code } = extractErrorMessage(parsed, response.status, response.statusText);
    throw new ApiError({ status: response.status, message, code, body: parsed });
  }

  if (init.raw) return parsed as T;
  return unwrapOk<T>(parsed);
}

/** Convenience wrappers. */
export const api = {
  get: <T = unknown>(path: string, init?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...init, method: "GET" }),
  post: <T = unknown>(path: string, body?: unknown, init?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...init, method: "POST", body }),
  put: <T = unknown>(path: string, body?: unknown, init?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...init, method: "PUT", body }),
  patch: <T = unknown>(path: string, body?: unknown, init?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...init, method: "PATCH", body }),
  delete: <T = unknown>(path: string, init?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...init, method: "DELETE" }),
};
