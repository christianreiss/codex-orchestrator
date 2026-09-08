import assert from "node:assert/strict";
import { describe, it } from "node:test";

const path: string = "../../../portal/src/lib/api.ts";
const portal = await import(path) as typeof import("../../../portal/src/lib/api");
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function stalledBody(signal: AbortSignal): Response {
  return { ok: true, status: 200, statusText: "OK", json: () => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }) } as Response;
}

describe("portal response deadlines", () => {
  it("keeps the timeout running after headers arrive", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(globalThis, "fetch", async (_path: string, init: RequestInit) => stalledBody(init.signal!));
    const result = assert.rejects(portal.fetchAgents(), (error: unknown) => error instanceof portal.ApiFailure && error.code === "portal_timeout");
    await settle();
    t.mock.timers.tick(20_000);
    await result;
  });

  it("retries an ambiguous body timeout once with the exact serialized message", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const bodies: BodyInit[] = [];
    t.mock.method(globalThis, "fetch", async (_path: string, init: RequestInit) => {
      bodies.push(init.body!);
      return bodies.length === 1 ? stalledBody(init.signal!) : new Response(JSON.stringify({ status: "ok", data: { message_id: "one" } }));
    });
    const result = portal.sendMessage("session1", "stable-id", "inspect");
    await settle();
    t.mock.timers.tick(20_000); await settle();
    t.mock.timers.tick(250); await settle();
    assert.deepEqual(await result, { message_id: "one" });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(JSON.parse(String(bodies[0])).client_message_id, "stable-id");
  });

  it("does not retry a disabled portal despite its503 status", async (t) => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return new Response(JSON.stringify({ status: "error", code: "agent_portal_disabled", message: "Disabled" }), { status: 503 });
    });
    await assert.rejects(portal.sendMessage("session1", "id", "inspect"), /Disabled/);
    assert.equal(requests, 1);
  });

  it("does not treat a truncated successful body as confirmation", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("{", { status: 200 }));
    await assert.rejects(portal.fetchAgents(), (error: unknown) => error instanceof portal.ApiFailure && error.code === "portal_invalid_response");
  });
});
