import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import { get } from "svelte/store";

import type { WsInfo } from "./client";

// `node --test` strips types but resolves specifiers verbatim: the module under
// test needs the ".ts" suffix TypeScript rejects on a static import, and its own
// extensionless "../api/client" import needs the same suffix applied at
// resolution time. Types come from the cast.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const extensionless = specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier);
    return nextResolve(extensionless ? `${specifier}.ts` : specifier, context);
  },
});
const wsModule: string = "./client.ts";
const { backoffMs, createWsClient } = (await import(wsModule)) as typeof import("./client");

const RECONNECT_MAX_MS = 30_000;

type Listener = (ev: unknown) => void;

/** Stand-in for the browser WebSocket; events are fired by the test, never on its own. */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  url: string;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    const forType = this.listeners.get(type) ?? [];
    forType.push(fn);
    this.listeners.set(type, forType);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeSocket.CLOSED;
  }

  emit(type: string, ev: unknown = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }

  /** Complete the handshake the way the browser would. */
  handshake(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }
}

interface FakeTimer {
  kind: "timeout" | "interval";
  delay: number;
  fn: () => void;
  cleared: boolean;
}

const timers = new Map<number, FakeTimer>();
let nextTimerId = 1;

function schedule(kind: FakeTimer["kind"], fn: () => void, delay: number): number {
  const id = nextTimerId++;
  timers.set(id, { kind, delay, fn, cleared: false });
  return id;
}

function pending(kind: FakeTimer["kind"]): FakeTimer[] {
  return [...timers.values()].filter((timer) => timer.kind === kind && !timer.cleared);
}

/** Fire the single pending timer of `kind` the client is waiting on. */
function fire(kind: FakeTimer["kind"]): void {
  const [timer, ...rest] = pending(kind);
  assert.ok(timer, `expected one pending ${kind}, found none`);
  assert.equal(rest.length, 0, `expected one pending ${kind}, found ${rest.length + 1}`);
  if (kind === "timeout") timer.cleared = true;
  timer.fn();
}

const g = globalThis as unknown as Record<string, unknown>;
const real = {
  fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
  random: Math.random,
  WebSocket: g.WebSocket,
  window: g.window,
};

/** Answered by every `/admin/ws/info` call; reassign between connects. */
let currentInfo: WsInfo = { enabled: true, url: "wss://host/admin/ws" };

function infoResponse(info: WsInfo): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ status: "ok", data: info }),
  } as unknown as Response;
}

/** Settle the awaited fetch chain inside connect(); timers are stubbed, so only microtasks remain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Construct a client and let its deferred first connect run. */
async function start(info: WsInfo) {
  currentInfo = info;
  const handle = createWsClient();
  await flush();
  return handle;
}

function lastSocket(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  assert.ok(socket, "expected a socket to have been opened");
  return socket;
}

beforeEach(() => {
  FakeSocket.instances = [];
  timers.clear();
  g.window = {};
  g.WebSocket = FakeSocket;
  g.fetch = async () => infoResponse(currentInfo);
  g.setTimeout = (fn: () => void, delay: number) => schedule("timeout", fn, delay);
  g.setInterval = (fn: () => void, delay: number) => schedule("interval", fn, delay);
  g.clearTimeout = (id: number) => {
    const timer = timers.get(id);
    if (timer) timer.cleared = true;
  };
  g.clearInterval = g.clearTimeout;
});

afterEach(() => {
  g.fetch = real.fetch;
  g.setTimeout = real.setTimeout;
  g.setInterval = real.setInterval;
  g.clearTimeout = real.clearTimeout;
  g.clearInterval = real.clearInterval;
  g.WebSocket = real.WebSocket;
  if (real.window === undefined) delete g.window;
  else g.window = real.window;
  Math.random = real.random;
});

describe("backoffMs", () => {
  it("never exceeds the 30s cap, jitter included", () => {
    for (const random of [0, 0.25, 0.5, 0.75, 0.999_999]) {
      Math.random = () => random;
      for (let attempt = 0; attempt <= 15; attempt += 1) {
        const delay = backoffMs(attempt);
        assert.ok(
          delay <= RECONNECT_MAX_MS,
          `attempt ${attempt} at jitter ${random} waited ${delay}ms`,
        );
        assert.ok(delay >= 750, `attempt ${attempt} at jitter ${random} waited ${delay}ms`);
      }
    }
  });

  it("doubles from 1s and saturates at the cap", () => {
    Math.random = () => 0.5; // mid-range jitter is a no-op multiplier
    assert.equal(backoffMs(0), 1_000);
    assert.equal(backoffMs(1), 2_000);
    assert.equal(backoffMs(4), 16_000);
    assert.equal(backoffMs(5), RECONNECT_MAX_MS);
    assert.equal(backoffMs(12), RECONNECT_MAX_MS);
  });
});

describe("createWsClient discovery", () => {
  it("goes disabled without opening a socket when the server says enabled:false", async () => {
    const client = await start({ enabled: false, url: "wss://host/admin/ws" });

    assert.equal(get(client.status), "disabled");
    assert.equal(FakeSocket.instances.length, 0);
    assert.equal(pending("timeout").length, 0);
  });

  it("goes disabled without opening a socket when the info carries no url", async () => {
    const client = await start({ enabled: true });

    assert.equal(get(client.status), "disabled");
    assert.equal(FakeSocket.instances.length, 0);
  });

  it("appends last_event_id with '?' on a bare url", async () => {
    await start({ enabled: true, url: "wss://host/admin/ws", last_event_id: 42 });

    assert.equal(lastSocket().url, "wss://host/admin/ws?last_event_id=42");
  });

  it("appends last_event_id with '&' on a url that already has a query", async () => {
    await start({ enabled: true, url: "wss://host/admin/ws?token=abc", last_event_id: 42 });

    assert.equal(lastSocket().url, "wss://host/admin/ws?token=abc&last_event_id=42");
  });

  it("leaves the url untouched when there is no last event id", async () => {
    await start({ enabled: true, url: "wss://host/admin/ws" });

    assert.equal(lastSocket().url, "wss://host/admin/ws");
  });
});

describe("createWsClient frames", () => {
  it("publishes a frame and resumes the next connect from its id", async () => {
    const client = await start({ enabled: true, url: "wss://host/admin/ws" });
    const socket = lastSocket();
    socket.handshake();
    assert.equal(get(client.status), "open");

    socket.emit("message", { data: JSON.stringify({ type: "job.updated", id: 77, data: { id: "j1" } }) });
    assert.deepEqual(get(client.events), { type: "job.updated", id: 77, data: { id: "j1" } });

    socket.emit("close");
    fire("timeout");
    await flush();

    assert.equal(lastSocket().url, "wss://host/admin/ws?last_event_id=77");
  });

  it("drops unparseable, non-string and type-less frames", async () => {
    const client = await start({ enabled: true, url: "wss://host/admin/ws" });
    const socket = lastSocket();
    socket.handshake();

    socket.emit("message", { data: "{not json" });
    socket.emit("message", { data: new ArrayBuffer(4) });
    socket.emit("message", { data: JSON.stringify({ id: 99, data: { id: "j1" } }) });

    assert.equal(get(client.events), null);

    // A dropped frame must not move the resume point either.
    socket.emit("close");
    fire("timeout");
    await flush();

    assert.equal(lastSocket().url, "wss://host/admin/ws");
  });

  it("pings on the heartbeat interval while the socket is open", async () => {
    await start({ enabled: true, url: "wss://host/admin/ws", heartbeat_seconds: 20 });
    const socket = lastSocket();
    socket.handshake();

    const [heartbeat] = pending("interval");
    assert.ok(heartbeat);
    assert.equal(heartbeat.delay, 20_000);

    heartbeat.fn();
    assert.deepEqual(socket.sent, ['{"type":"ping"}']);

    // A closing socket stops answering.
    socket.readyState = FakeSocket.CLOSED;
    heartbeat.fn();
    assert.equal(socket.sent.length, 1);
  });
});

describe("createWsClient lifecycle", () => {
  it("reconnects after a close", async () => {
    const client = await start({ enabled: true, url: "wss://host/admin/ws" });
    lastSocket().handshake();

    lastSocket().emit("close");
    assert.equal(get(client.status), "closed");
    assert.equal(pending("timeout").length, 1);

    fire("timeout");
    await flush();

    assert.equal(FakeSocket.instances.length, 2);
    assert.equal(get(client.status), "connecting");
  });

  it("stop() closes the socket and suppresses the reconnect a later close would schedule", async () => {
    const client = await start({ enabled: true, url: "wss://host/admin/ws" });
    const socket = lastSocket();
    socket.handshake();

    client.stop();
    assert.equal(socket.closeCalls, 1);
    assert.equal(get(client.status), "closed");

    socket.emit("close");
    assert.equal(pending("timeout").length, 0);
    assert.equal(FakeSocket.instances.length, 1);
  });

  it("stop() clears the heartbeat interval", async () => {
    const client = await start({ enabled: true, url: "wss://host/admin/ws", heartbeat_seconds: 20 });
    lastSocket().handshake();
    assert.equal(pending("interval").length, 1);

    client.stop();
    assert.equal(pending("interval").length, 0);
  });

  it("stop() clears a pending reconnect timer", async () => {
    const client = await start({ enabled: true, url: "wss://host/admin/ws" });
    lastSocket().handshake();
    lastSocket().emit("close");
    assert.equal(pending("timeout").length, 1);

    client.stop();
    assert.equal(pending("timeout").length, 0);
  });

  it("retries when the info request fails", async () => {
    g.fetch = async () => {
      throw new Error("network down");
    };
    const client = createWsClient();
    await flush();

    assert.equal(FakeSocket.instances.length, 0);
    assert.equal(pending("timeout").length, 1);

    client.stop();
  });
});
