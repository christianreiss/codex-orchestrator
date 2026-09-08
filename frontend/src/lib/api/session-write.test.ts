import assert from "node:assert/strict";
import { describe, it } from "node:test";

const path: string = "./session-write.ts";
const { createSessionWriter } = await import(path) as typeof import("./session-write");
const failure = (status: number, code?: string) => Object.assign(new Error("rejected"), { status, code });

describe("stable client mutations", () => {
  it("confirms a lost delivery on human retry, then allows a new identical instruction", async () => {
    const write = createSessionWriter({ actor: () => "admin1", retryDelayMs: 0 });
    const rows = new Map<string, object>();
    const requests: string[] = [];
    const perform = async (id: string) => {
      requests.push(id);
      if (!rows.has(id)) rows.set(id, { message_id: `message${rows.size + 1}` });
      if (requests.length <= 2) throw new TypeError("reply lost after commit");
      return rows.get(id)!;
    };
    await assert.rejects(write("session1/message/inspect", perform), /reply lost/);
    assert.equal(requests.length, 2);
    assert.equal(rows.size, 1);
    await write("session1/message/inspect", perform);
    assert.equal(new Set(requests).size, 1);
    await write("session1/message/inspect", perform);
    assert.equal(rows.size, 2, "a confirmed instruction must not dedupe a later intentional repeat");
  });

  it("does not carry an uncertain key into another actor, session, or prompt", async () => {
    let actor = "admin1";
    const write = createSessionWriter({ actor: () => actor, retryDelayMs: 0 });
    const keys: string[] = [];
    const fail = async (id: string) => { keys.push(id); throw failure(503); };
    for (const intent of ["session1/answer/prompt1/yes", "session2/answer/prompt1/yes", "session1/answer/prompt2/yes"]) {
      await assert.rejects(write(intent, fail));
    }
    actor = "admin2";
    await assert.rejects(write("session1/answer/prompt1/yes", fail));
    assert.equal(keys.length, 8);
    assert.equal(new Set(keys).size, 4);
  });

  it("keeps an uncertain key when a later denial cannot disprove the first commit", async () => {
    const write = createSessionWriter({ actor: () => "admin1", retryDelayMs: 0 });
    const keys: string[] = [];
    await assert.rejects(write("same", async (id) => {
      keys.push(id);
      if (keys.length === 1) throw new TypeError("reply lost");
      throw failure(403);
    }));
    await write("same", async (id) => { keys.push(id); return { message_id: "original" }; });
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 1);
  });

  it("never retries using a newly signed-in account", async () => {
    let actor: string | null = "admin1";
    const write = createSessionWriter({ actor: () => actor, retryDelayMs: 0 });
    let calls = 0;
    await assert.rejects(write("session/message", async () => {
      calls++; actor = "admin2"; throw new TypeError("lost response");
    }), /signed-in account changed/);
    assert.equal(calls, 1);
    actor = null;
    await assert.rejects(write("session/message", async () => { calls++; return {}; }), /Sign in again/);
    assert.equal(calls, 1);
  });

  for (const [status, code] of [[401, undefined], [403, undefined], [409, "already_answered"], [503, "agent_portal_disabled"]] as const) {
    it(`does not retry definitive ${code ?? status} and discards its key`, async () => {
      const write = createSessionWriter({ actor: () => "admin1", retryDelayMs: 0 });
      const keys: string[] = [];
      const fail = async (id: string) => { keys.push(id); throw failure(status, code); };
      await assert.rejects(write("same", fail));
      await assert.rejects(write("same", fail));
      assert.equal(keys.length, 2);
      assert.notEqual(keys[0], keys[1]);
    });
  }

  it("bounds a body stall even if the transport swallows its abort", async () => {
    const write = createSessionWriter({ actor: () => "admin1", timeoutMs: 5, retryDelayMs: 0 });
    const ids: string[] = [];
    let aborted = 0;
    await assert.rejects(write("same", (id, signal) => {
      ids.push(id);
      return new Promise((resolve) => signal.addEventListener("abort", () => { aborted++; resolve(undefined); }));
    }), /Delivery was not confirmed/);
    assert.equal(aborted, 2);
    assert.equal(new Set(ids).size, 1);
  });

  it("retains the key if a malformed success cannot confirm delivery", async () => {
    const write = createSessionWriter({ actor: () => "admin1", retryDelayMs: 0,
      confirmed: (result) => typeof (result as { message_id?: unknown }).message_id === "string" });
    const ids: string[] = [];
    await assert.rejects(write("same", async (id) => { ids.push(id); return {}; }), /did not confirm/);
    await write("same", async (id) => { ids.push(id); return { message_id: "confirmed" }; });
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 1);
  });
});
