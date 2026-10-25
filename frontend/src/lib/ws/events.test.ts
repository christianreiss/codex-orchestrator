import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writable, type Writable } from "svelte/store";

import type { QueryClient, QueryKey } from "@tanstack/svelte-query";
import type { WsEvent } from "./client";

// `events.ts` reaches for the real sonner Toaster, which needs a browser; the
// stub answers that import with a recorder so each toast branch is observable.
const TOAST_STUB = "stub:svelte-sonner";

const toastStubSource = `
export const stub = { calls: [] };
function record(level) {
  return (message, options) => {
    stub.calls.push({ level, message, options });
  };
}
export const toast = {
  success: record("success"),
  warning: record("warning"),
  error: record("error"),
  info: record("info"),
};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "svelte-sonner") return { url: TOAST_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === TOAST_STUB) {
      return { format: "module", shortCircuit: true, source: toastStubSource };
    }
    return nextLoad(url, context);
  },
});

interface ToastCall {
  level: string;
  message: string;
  options: { description?: string; duration?: number };
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const toastModule: string = TOAST_STUB;
const { stub: toastStub } = (await import(toastModule)) as { stub: { calls: ToastCall[] } };

const eventsModule: string = "./events.ts";
const { DEFAULT_INVALIDATIONS, createCoalescingInvalidator, wireWsToQueryClient, ownerStateInvalidations } = (await import(
  eventsModule
)) as typeof import("./events");

/** Records every key the wiring asks to invalidate, in order. */
class FakeQueryClient {
  keys: QueryKey[] = [];
  options: unknown[] = [];
  fetching = new Set<string>();

  invalidateQueries(filters: { queryKey: QueryKey }, options?: unknown): Promise<void> {
    this.keys.push(filters.queryKey);
    this.options.push(options);
    return Promise.resolve();
  }

  isFetching(filters: { queryKey: QueryKey }): number {
    return this.fetching.has(JSON.stringify(filters.queryKey)) ? 1 : 0;
  }
}

let qc: FakeQueryClient;
let events: Writable<WsEvent | null>;
let unsubscribe: () => void;

beforeEach(() => {
  qc = new FakeQueryClient();
  events = writable(null);
  toastStub.calls.length = 0;
  // A zero window dispatches synchronously, so the mapping tests stay ordered.
  unsubscribe = wireWsToQueryClient(qc as unknown as QueryClient, events, DEFAULT_INVALIDATIONS, 0);
});

afterEach(() => {
  unsubscribe();
});

/** Push one event through the wiring; `payload` is the field the dispatcher reads. */
function emit(type: string, payload?: unknown): void {
  events.set({ type, payload, ts: "2026-01-01T00:00:00.000Z" });
}

it("resamples every active snapshot after WS reconnect", () => {
  emit("transport.connected");
  assert.deepEqual(qc.keys, [[]]);
});

describe("toast events", () => {
  it("maps each level onto the matching sonner call", () => {
    for (const [level, expected] of [
      ["success", "success"],
      ["warn", "warning"],
      ["error", "error"],
      ["info", "info"],
    ]) {
      toastStub.calls.length = 0;
      emit("toast", { message: "hello", level });
      assert.deepEqual(
        toastStub.calls.map((call) => call.level),
        [expected],
      );
    }
  });

  it("falls back to info for an unknown or absent level", () => {
    emit("toast", { message: "hello", level: "chartreuse" });
    emit("toast", { message: "hello" });
    assert.deepEqual(
      toastStub.calls.map((call) => call.level),
      ["info", "info"],
    );
  });

  it("shows the title as the primary line with the message as its description", () => {
    emit("toast", { message: "the long body", title: "Heads up", timeout_ms: 4000 });
    assert.deepEqual(toastStub.calls, [
      {
        level: "info",
        message: "Heads up",
        options: { description: "the long body", duration: 4000 },
      },
    ]);
  });

  it("promotes the message when no usable title or timeout was sent", () => {
    emit("toast", { message: "body only", title: "", timeout_ms: "4000" });
    assert.deepEqual(toastStub.calls, [
      { level: "info", message: "body only", options: { description: undefined, duration: undefined } },
    ]);
  });

  it("shows nothing when the message is missing, empty or not a string", () => {
    emit("toast");
    emit("toast", null);
    emit("toast", "just a string");
    emit("toast", {});
    emit("toast", { message: "" });
    emit("toast", { message: 42 });
    assert.deepEqual(toastStub.calls, []);
  });

  it("never invalidates anything", () => {
    emit("toast", { message: "hello", level: "error" });
    assert.equal(toastStub.calls.length, 1);
    assert.deepEqual(qc.keys, []);
  });
});

describe("mapped events", () => {
  it("invalidates exactly the keys the map names", () => {
    emit("log.created");
    assert.deepEqual(qc.keys, [["logs"], ["logs", "api"], ["logs", "events"]]);
  });

  it("invalidates the mapped keys for every entry in the map", () => {
    for (const [type, keys] of Object.entries(DEFAULT_INVALIDATIONS)) {
      qc.keys = [];
      emit(type);
      assert.deepEqual(qc.keys.slice(0, keys.length), keys, type);
    }
  });

  it("keeps Agent Messaging state, host and delivery views live", () => {
    emit("agent_messaging.state.changed");
    assert.deepEqual(qc.keys, [["agent-messaging"]]);

    qc.keys = [];
    emit("agent_messaging.host.changed");
    assert.deepEqual(qc.keys, [["agent-messaging"], ["hosts"]]);

    for (const type of [
      "agent_messaging.address.changed",
      "agent_messaging.conversation.changed",
      "agent_messaging.message.changed",
      "agent_messaging.relay.changed",
      "agent_messaging.queue.changed",
    ]) {
      qc.keys = [];
      emit(type);
      assert.deepEqual(qc.keys, type === "agent_messaging.message.changed" ? [["agent-messaging"], ["schedules"]] : [["agent-messaging"]], type);
    }
  });

  it("does not broadcast or invalidate audited plaintext reveal", () => {
    assert.equal(DEFAULT_INVALIDATIONS["agent_messaging.message.revealed"], undefined);
    emit("agent_messaging.message.revealed");
    assert.deepEqual(qc.keys, []);
  });

  it("invalidates nothing for a null event or an unmapped type", () => {
    events.set(null);
    emit("");
    emit("nothing.listens.to.this");
    assert.deepEqual(qc.keys, []);
    assert.deepEqual(toastStub.calls, []);
  });
});

describe("project-scoped events", () => {
  it("adds the detail sub-key and the changes key for each child collection", () => {
    for (const [type, subKey] of [
      ["project.note.created", "notes"],
      ["project.note.updated", "notes"],
      ["project.note.deleted", "notes"],
      ["project.todo.created", "todos"],
      ["project.todo.updated", "todos"],
      ["project.todo.deleted", "todos"],
      ["project.file.upserted", "files"],
      ["project.file.updated", "files"],
      ["project.file.deleted", "files"],
      ["project.feedback.created", "feedback"],
    ]) {
      qc.keys = [];
      emit(type, { slug: "acme" });
      assert.deepEqual(
        qc.keys,
        [["projects"], ["project", "acme", subKey], ["project", "acme", "changes"], ["projects"]],
        type,
      );
    }
  });

  it("adds only the project key for whole-project events", () => {
    for (const type of [
      "project.changed",
      "project.updated",
      "project.created",
      "project.deleted",
    ]) {
      qc.keys = [];
      emit(type, { slug: "acme" });
      assert.deepEqual(qc.keys, [["projects"], ["project", "acme"], ["projects"]], type);
    }
  });

  it("resolves the slug from slug, project or project_slug", () => {
    for (const payload of [{ slug: "acme" }, { project: "acme" }, { project_slug: "acme" }]) {
      qc.keys = [];
      emit("project.updated", payload);
      assert.deepEqual(qc.keys, [["projects"], ["project", "acme"], ["projects"]]);
    }
  });

  it("still refreshes the project list when no usable slug is present", () => {
    for (const payload of [undefined, null, "acme", {}, { slug: "" }, { slug: 7 }]) {
      qc.keys = [];
      emit("project.note.created", payload);
      assert.deepEqual(qc.keys, [["projects"], ["projects"]]);
    }
  });
});

describe("the returned unsubscribe", () => {
  it("stops the wiring from reacting to further events", () => {
    unsubscribe();
    emit("log.created");
    emit("toast", { message: "hello" });
    assert.deepEqual(qc.keys, []);
    assert.deepEqual(toastStub.calls, []);
  });
});

describe("coalesced invalidation", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("collapses a burst into one invalidation per key that never cancels a running fetch", async () => {
    const fake = new FakeQueryClient();
    const inv = createCoalescingInvalidator(fake as unknown as QueryClient, 10);
    for (let i = 0; i < 50; i++) {
      inv.invalidate(["topology"]);
      inv.invalidate(["communicators"]);
    }
    assert.deepEqual(fake.keys, []);
    await sleep(30);
    assert.deepEqual(fake.keys, [["topology"], ["communicators"]]);
    assert.deepEqual(fake.options, [{ cancelRefetch: false }, { cancelRefetch: false }]);
    inv.dispose();
  });

  it("waits for an in-flight fetch and then refreshes exactly once", async () => {
    const fake = new FakeQueryClient();
    const inv = createCoalescingInvalidator(fake as unknown as QueryClient, 10);
    fake.fetching.add(JSON.stringify(["topology"]));
    inv.invalidate(["topology"]);
    await sleep(35);
    assert.deepEqual(fake.keys, []);
    fake.fetching.clear();
    await sleep(25);
    assert.deepEqual(fake.keys, [["topology"]]);
    inv.dispose();
  });

  it("drops pending work on dispose", async () => {
    const fake = new FakeQueryClient();
    const inv = createCoalescingInvalidator(fake as unknown as QueryClient, 10);
    inv.invalidate(["topology"]);
    inv.dispose();
    await sleep(25);
    assert.deepEqual(fake.keys, []);
  });
});

it("workflow invalidation refreshes reports and managed communication after changes and reconnect", () => {
  assert.deepEqual(DEFAULT_INVALIDATIONS["workflow.changed"], [["workflows"],["workflow-runs"]]);
  assert.deepEqual(DEFAULT_INVALIDATIONS["workflow.run.changed"], [["workflow-runs"],["agent-messaging"]]);
  assert.deepEqual(DEFAULT_INVALIDATIONS["transport.connected"], [[]]);
});


it("resnapshots all query domains when the owner stream has a gap", () => {
  emit("transport.resync");
  assert.deepEqual(qc.keys, [[]]);
});

it("refreshes attachment preparation on its owner event", () => {
  emit("agent_chat.attachment.changed");
  assert.deepEqual(qc.keys, [["chat-attachments"]]);
});


it("coalesces a reconnect resnapshot and descendant invalidations into one fetch", async () => {
  const fake = new FakeQueryClient();
  const inv = createCoalescingInvalidator(fake as unknown as QueryClient, 5);
  inv.invalidate(["hosts"]);
  inv.invalidate([]);
  inv.invalidate(["hosts", "detail", "1"]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(fake.keys, [[]]);
  inv.dispose();
});


it("routes owner changes centrally and conservatively resnapshots unknown domains", () => {
  assert.deepEqual(ownerStateInvalidations({ tables: ["feedbackItems"] }), [["feedback"], ["agents"]]);
  assert.deepEqual(ownerStateInvalidations({ tables: ["futureOwnedDomain"] }), [[]]);
  assert.deepEqual(ownerStateInvalidations({ tables: [null] }), [[]]);
  assert.deepEqual(ownerStateInvalidations({ tables: [] }), []);
});


it("keeps ordinary session and host observations scoped to their views", () => {
  for(const table of ["agentSessions","agentBusMessages","hosts","hostDaemons","coordProjectFiles","versions"]){
    const keys=ownerStateInvalidations({tables:[table]});
    assert.ok(keys.length>0);assert.ok(keys.every(key=>key.length>0),`${table} invalidated all queries`);
  }
});
