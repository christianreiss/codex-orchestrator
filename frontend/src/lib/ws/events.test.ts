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
const { DEFAULT_INVALIDATIONS, wireWsToQueryClient } = (await import(
  eventsModule
)) as typeof import("./events");

/** Records every key the wiring asks to invalidate, in order. */
class FakeQueryClient {
  keys: QueryKey[] = [];

  invalidateQueries(filters: { queryKey: QueryKey }): Promise<void> {
    this.keys.push(filters.queryKey);
    return Promise.resolve();
  }
}

let qc: FakeQueryClient;
let events: Writable<WsEvent | null>;
let unsubscribe: () => void;

beforeEach(() => {
  qc = new FakeQueryClient();
  events = writable(null);
  toastStub.calls.length = 0;
  unsubscribe = wireWsToQueryClient(qc as unknown as QueryClient, events);
});

afterEach(() => {
  unsubscribe();
});

/** Push one event through the wiring; `payload` is the field the dispatcher reads. */
function emit(type: string, payload?: unknown): void {
  events.set({ type, payload, ts: "2026-01-01T00:00:00.000Z" });
}

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
