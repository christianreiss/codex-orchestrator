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
  document: g.document,
  now: Date.now,
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
  g.window = new EventTarget();
  g.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
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
  Date.now = real.now;
  if (real.document === undefined) delete g.document;
  else g.document = real.document;
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
    (g.window as EventTarget).dispatchEvent(new Event("online"));
    await flush();
    assert.equal(FakeSocket.instances.length, 0);
    assert.equal(pending("timeout").length, 0);
    client.stop();
  });

  it("retries missing URL metadata and opens after valid discovery returns", async () => {
    const client = await start({ enabled: true });

    assert.equal(get(client.status), "closed");
    assert.equal(FakeSocket.instances.length, 0);
    assert.equal(pending("timeout").length, 1);
    currentInfo = { enabled: true, url: "wss://host/admin/ws" };
    fire("timeout");
    await flush();
    lastSocket().handshake();
    assert.equal(get(client.status), "open");
    client.stop();
  });

  for (const [label, raw, status] of [
    ["no-content response", null, 204],
    ["invalid JSON", "{", 200],
    ["null metadata", "null", 200],
    ["primitive metadata", "42", 200],
    ["array metadata", "[]", 200],
    ["missing enabled flag", JSON.stringify({ url: "wss://host/admin/ws" }), 200],
    ["non-string URL", JSON.stringify({ enabled: true, url: 42 }), 200],
    ["blank URL", JSON.stringify({ enabled: true, url: "   " }), 200],
  ] as const) {
    it(`retries ${label} instead of throwing or disabling updates`, async () => {
      g.fetch = async () => new Response(raw, { status, headers: { "content-type": "application/json" } });
      const client = createWsClient();
      await flush();
      assert.equal(get(client.status), "closed");
      assert.equal(FakeSocket.instances.length, 0);
      assert.equal(pending("timeout").length, 1);
      g.fetch = async () => infoResponse({ enabled: true, url: "wss://recovered/admin/ws" });
      fire("timeout");
      await flush();
      lastSocket().handshake();
      assert.equal(get(client.status), "open");
      client.stop();
    });
  }

  it("allows enabled:false without a URL as an explicit disabled response", async () => {
    const client = await start({ enabled: false });
    assert.equal(get(client.status), "disabled");
    assert.equal(pending("timeout").length, 0);
    client.stop();
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

  it("re-reads the resume point from the info response on every reconnect", async () => {
    await start({ enabled: true, url: "wss://host/admin/ws" });
    lastSocket().handshake();

    currentInfo = { enabled: true, url: "wss://host/admin/ws", last_event_id: 77 };
    lastSocket().emit("close");
    fire("timeout");
    await flush();

    assert.equal(lastSocket().url, "wss://host/admin/ws?last_event_id=77");
  });
});

describe("createWsClient frames", () => {
  it("publishes the frame the server sent", async () => {
    const client = await start({ enabled: true, url: "wss://host/admin/ws" });
    const socket = lastSocket();
    socket.handshake();
    assert.equal(get(client.status), "open");

    const frame = {
      type: "project.updated",
      payload: { slug: "acme" },
      ts: "2026-01-01T00:00:00.000Z",
    };
    socket.emit("message", { data: JSON.stringify(frame) });
    assert.deepEqual(get(client.events), frame);
  });

  it("drops unparseable, non-string and type-less frames", async () => {
    const client = await start({ enabled: true, url: "wss://host/admin/ws" });
    const socket = lastSocket();
    socket.handshake();
    const connected = get(client.events);

    socket.emit("message", { data: "{not json" });
    socket.emit("message", { data: new ArrayBuffer(4) });
    socket.emit("message", { data: JSON.stringify({ payload: { slug: "acme" }, ts: "now" }) });

    assert.deepEqual(get(client.events), connected);
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
  it("respects a 600-second server heartbeat instead of retiring the socket early", async () => {
    let now = 0;
    Date.now = () => now;
    const client = await start({ enabled: true, url: "wss://host/admin/ws", heartbeat_seconds: 600 });
    const socket = lastSocket();
    socket.handshake();
    assert.equal(pending("interval")[0]?.delay, 600_000);
    now = 600_000;
    fire("interval");
    assert.equal(get(client.status), "open");
    assert.equal(socket.closeCalls, 0);
    socket.emit("message", { data: JSON.stringify({ type: "ping", ts: "now" }) });
    now = 1_200_000;
    fire("interval");
    assert.equal(get(client.status), "open");
    now = 2_400_000;
    fire("interval");
    assert.equal(get(client.status), "closed");
    assert.equal(socket.closeCalls, 1);
    client.stop();
  });
  it("refreshes the client snapshot on each successful connection", async () => {
    const client = await start({ enabled: true, url: "wss://host/admin/ws" });
    const frames: string[] = [];
    const unsubscribe = client.events.subscribe((event) => { if (event) frames.push(event.type); });
    lastSocket().handshake();
    lastSocket().emit("close");
    fire("timeout");
    await flush();
    lastSocket().handshake();
    assert.deepEqual(frames, ["transport.connected", "transport.connected"]);
    unsubscribe();
    client.stop();
  });

  it("retires a silent socket even when the browser never reports a close", async () => {
    let now = 0;
    Date.now = () => now;
    const client = await start({ enabled: true, url: "wss://host/admin/ws", heartbeat_seconds: 20 });
    const stale = lastSocket();
    stale.handshake();
    now = 60_000;
    fire("interval");
    assert.equal(get(client.status), "closed");
    assert.equal(stale.closeCalls, 1);
    assert.equal(pending("timeout").length, 1);
    // Late callbacks cannot revive it or schedule a duplicate reconnect.
    stale.handshake();
    stale.emit("error");
    stale.emit("close");
    assert.equal(get(client.status), "closed");
    assert.equal(pending("interval").length, 0);
    assert.equal(pending("timeout").length, 1);
    client.stop();
  });

  it("server heartbeat frames keep an otherwise idle connection alive", async () => {
    let now = 0;
    Date.now = () => now;
    const client = await start({ enabled: true, url: "wss://host/admin/ws", heartbeat_seconds: 20 });
    const socket = lastSocket();
    socket.handshake();
    now = 40_000;
    socket.emit("message", { data: JSON.stringify({ type: "ping", ts: "now" }) });
    now = 60_000;
    fire("interval");
    assert.equal(get(client.status), "open");
    assert.equal(socket.closeCalls, 0);
    client.stop();
  });

  it("aborts stalled discovery and ignores its late result", async () => {
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    g.fetch = async (_url: string, options: RequestInit) => {
      signal = options.signal ?? undefined;
      return new Promise<Response>((done) => { resolve = done; });
    };
    const client = createWsClient();
    await flush();
    fire("timeout");
    assert.equal(signal?.aborted, true);
    assert.equal(get(client.status), "closed");
    resolve(infoResponse({ enabled: true, url: "wss://late/admin/ws" }));
    await flush();
    assert.equal(FakeSocket.instances.length, 0);
    assert.equal(pending("timeout").length, 1);
    client.stop();
  });

  it("times out an incomplete socket handshake and ignores retired frames", async () => {
    const client = await start({ enabled: true, url: "wss://host/admin/ws" });
    const old = lastSocket();
    fire("timeout");
    assert.equal(old.closeCalls, 1);
    fire("timeout");
    await flush();
    const replacement = lastSocket();
    replacement.handshake();
    const event = get(client.events);
    old.emit("message", { data: JSON.stringify({ type: "host.deleted", payload: {} }) });
    old.emit("close");
    assert.deepEqual(get(client.events), event);
    assert.equal(get(client.status), "open");
    assert.equal(pending("timeout").length, 0);
    client.stop();
  });

  it("reconnects on waking from sleep and removes wake listeners on stop", async () => {
    let now = 0;
    Date.now = () => now;
    const client = await start({ enabled: true, url: "wss://host/admin/ws", heartbeat_seconds: 20 });
    const socket = lastSocket();
    socket.handshake();
    now = 90_000;
    (g.document as EventTarget).dispatchEvent(new Event("visibilitychange"));
    await flush();
    assert.equal(FakeSocket.instances.length, 2);
    assert.equal(socket.closeCalls, 1);
    client.stop();
    (g.window as EventTarget).dispatchEvent(new Event("online"));
    await flush();
    assert.equal(FakeSocket.instances.length, 2);
    assert.equal(pending("timeout").length, 0);
  });

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
