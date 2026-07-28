import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { ApiError as ApiErrorInstance } from "./client";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const clientModule: string = "./client.ts";
const { ApiError, apiFetch } = (await import(clientModule)) as typeof import("./client");

const realFetch = globalThis.fetch;

/** Answer every `fetch` call in the current test with `response`. */
function stubFetch(response: Response): void {
  globalThis.fetch = async () => response;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { ...init, headers: { "content-type": "text/plain" } });
}

/** Await a rejecting `apiFetch` and hand back the `ApiError` it threw. */
async function caught(promise: Promise<unknown>): Promise<ApiErrorInstance> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected apiFetch to reject");
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("apiFetch error envelopes", () => {
  it("decodes the admin {status: 'error'} envelope", async () => {
    stubFetch(
      jsonResponse(
        { status: "error", message: "host is offline", code: "host_offline" },
        { status: 409, statusText: "Conflict" },
      ),
    );

    const err = await caught(apiFetch("/admin/api/hosts/h1"));
    assert.equal(err.status, 409);
    assert.equal(err.message, "host is offline");
    assert.equal(err.code, "host_offline");
  });

  it("decodes the Anthropic {type: 'error', error: {...}} envelope", async () => {
    // This body also matches the OpenAI shape; the Anthropic branch runs first.
    stubFetch(
      jsonResponse(
        { type: "error", error: { type: "invalid_request_error", message: "max_tokens is too large" } },
        { status: 400, statusText: "Bad Request" },
      ),
    );

    const err = await caught(apiFetch("/v1/messages", { method: "POST", body: {} }));
    assert.equal(err.status, 400);
    assert.equal(err.message, "max_tokens is too large");
    assert.equal(err.code, "invalid_request_error");
  });

  it("prefers error.code over error.type in the Anthropic envelope", async () => {
    stubFetch(
      jsonResponse(
        {
          type: "error",
          error: { type: "authentication_error", code: "invalid_api_key", message: "invalid x-api-key" },
        },
        { status: 401, statusText: "Unauthorized" },
      ),
    );

    const err = await caught(apiFetch("/v1/messages", { method: "POST", body: {} }));
    assert.equal(err.status, 401);
    assert.equal(err.message, "invalid x-api-key");
    assert.equal(err.code, "invalid_api_key");
  });

  it("decodes the OpenAI {error: {...}} envelope", async () => {
    stubFetch(
      jsonResponse(
        { error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } },
        { status: 429, statusText: "Too Many Requests" },
      ),
    );

    const err = await caught(apiFetch("/v1/chat/completions", { method: "POST", body: {} }));
    assert.equal(err.status, 429);
    assert.equal(err.message, "Rate limit reached");
    assert.equal(err.code, "rate_limit_exceeded");
  });

  it("falls back to error.type when the OpenAI envelope carries no code", async () => {
    stubFetch(
      jsonResponse(
        { error: { message: "model not found", type: "invalid_request_error" } },
        { status: 404, statusText: "Not Found" },
      ),
    );

    const err = await caught(apiFetch("/v1/chat/completions", { method: "POST", body: {} }));
    assert.equal(err.status, 404);
    assert.equal(err.message, "model not found");
    assert.equal(err.code, "invalid_request_error");
  });

  it("falls back to the status text for a non-JSON error body", async () => {
    stubFetch(textResponse("upstream exploded", { status: 502, statusText: "Bad Gateway" }));

    const err = await caught(apiFetch("/admin/api/hosts"));
    assert.equal(err.status, 502);
    assert.equal(err.message, "Bad Gateway");
    assert.equal(err.code, undefined);
    assert.equal(err.body, "upstream exploded");
  });

  it("falls back to the status code when there is no status text", async () => {
    stubFetch(textResponse("", { status: 500, statusText: "" }));

    const err = await caught(apiFetch("/admin/api/hosts"));
    assert.equal(err.status, 500);
    assert.equal(err.message, "HTTP 500");
    assert.equal(err.code, undefined);
  });
});

describe("apiFetch success bodies", () => {
  it("unwraps the {status: 'ok', data} envelope", async () => {
    stubFetch(jsonResponse({ status: "ok", data: { id: "h1", online: true } }, { status: 200 }));

    assert.deepEqual(await apiFetch("/admin/api/hosts/h1"), { id: "h1", online: true });
  });

  it("returns bodies that are not an ok envelope untouched", async () => {
    stubFetch(jsonResponse({ status: "ok" }, { status: 200 }));

    assert.deepEqual(await apiFetch("/admin/api/hosts/h1"), { status: "ok" });
  });

  it("parses a JSON body served without a JSON content-type", async () => {
    stubFetch(textResponse(JSON.stringify({ status: "ok", data: [1, 2] }), { status: 200 }));

    assert.deepEqual(await apiFetch("/admin/api/hosts"), [1, 2]);
  });

  it("returns plain text as-is when the body is not JSON", async () => {
    stubFetch(textResponse("pong", { status: 200 }));

    assert.equal(await apiFetch("/admin/api/ping"), "pong");
  });

  it("skips both text parsing and unwrapping for raw requests", async () => {
    stubFetch(textResponse("line one\nline two", { status: 200 }));

    assert.equal(await apiFetch("/admin/api/logs", { raw: true }), "line one\nline two");
  });

  it("keeps the envelope intact for raw JSON requests", async () => {
    stubFetch(jsonResponse({ status: "ok", data: { id: "h1" } }, { status: 200 }));

    assert.deepEqual(await apiFetch("/admin/api/hosts/h1", { raw: true }), {
      status: "ok",
      data: { id: "h1" },
    });
  });

  it("resolves to undefined for 204 responses", async () => {
    stubFetch(new Response(null, { status: 204 }));

    assert.equal(await apiFetch("/admin/api/hosts/h1", { method: "DELETE" }), undefined);
  });
});
