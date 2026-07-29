import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, describe, it } from "node:test";

import type { AdminAuditLogRow, HostFqdnSummary, McpAccessLogRow } from "./types";

// `logs.ts` reaches the network only through the real `./client`, so `fetch` is
// the seam these tests stub. ESM resolves specifiers verbatim, though, and the
// extensionless "./client" it imports has no file behind it at runtime.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./client") return nextResolve("./client.ts", context);
    return nextResolve(specifier, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const logsModule: string = "./logs.ts";
const { buildHostLabelMap, eventLogsQuery, hostsForLogsQuery, mcpLogsQuery } = (await import(
  logsModule
)) as typeof import("./logs");

const realFetch = globalThis.fetch;

/**
 * Answer every `fetch` call with `body` as JSON, handing back the list the
 * requested URLs are recorded into.
 */
function captureFetch(body: unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  return urls;
}

/** A builder's `queryFn`, callable without svelte-query's context argument. */
function queryFnOf<T>(options: unknown): () => Promise<T> {
  return (options as { queryFn: () => Promise<T> }).queryFn;
}

/** `/admin/mcp/logs` serves a bare `{logs}` body. */
const mcpRow = {
  id: 7,
  host_id: 3,
  host_fqdn: "edge-01.example",
  method: "tools/call",
  name: "memory_search",
  success: 1,
  created_at: "2026-07-29T04:00:00Z",
};

/** `/admin/logs` serves `{logs}` inside the admin ok envelope. */
const eventRow = {
  id: 12,
  host_id: 3,
  action: "host.restart",
  created_at: "2026-07-29T04:01:00Z",
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("mcpLogsQuery", () => {
  it("requests and keys the default limit", async () => {
    const urls = captureFetch({ logs: [mcpRow] });
    const options = mcpLogsQuery();

    assert.deepEqual(options.queryKey, ["logs", "mcp", { limit: 200 }]);
    assert.deepEqual(await queryFnOf<McpAccessLogRow[]>(options)(), [mcpRow]);
    assert.deepEqual(urls, ["/admin/mcp/logs?limit=200"]);
  });

  it("requests and keys an explicit limit", async () => {
    const urls = captureFetch({ logs: [] });
    const options = mcpLogsQuery(25);

    assert.deepEqual(options.queryKey, ["logs", "mcp", { limit: 25 }]);
    assert.deepEqual(await queryFnOf<McpAccessLogRow[]>(options)(), []);
    assert.deepEqual(urls, ["/admin/mcp/logs?limit=25"]);
  });

  it("yields [] for a non-array logs value", async () => {
    captureFetch({ logs: { 0: mcpRow } });

    assert.deepEqual(await queryFnOf<McpAccessLogRow[]>(mcpLogsQuery())(), []);
  });

  it("yields [] for a body carrying no logs key at all", async () => {
    captureFetch({ count: 0 });

    assert.deepEqual(await queryFnOf<McpAccessLogRow[]>(mcpLogsQuery())(), []);
  });
});

describe("eventLogsQuery", () => {
  it("requests and keys the default limit", async () => {
    const urls = captureFetch({ status: "ok", data: { logs: [eventRow] } });
    const options = eventLogsQuery();

    assert.deepEqual(options.queryKey, ["logs", "events", { limit: 200 }]);
    assert.deepEqual(await queryFnOf<AdminAuditLogRow[]>(options)(), [eventRow]);
    assert.deepEqual(urls, ["/admin/logs?limit=200"]);
  });

  it("requests and keys an explicit limit", async () => {
    const urls = captureFetch({ status: "ok", data: { logs: [] } });
    const options = eventLogsQuery(50);

    assert.deepEqual(options.queryKey, ["logs", "events", { limit: 50 }]);
    assert.deepEqual(await queryFnOf<AdminAuditLogRow[]>(options)(), []);
    assert.deepEqual(urls, ["/admin/logs?limit=50"]);
  });

  it("yields [] for a non-array logs value", async () => {
    captureFetch({ status: "ok", data: { logs: "none" } });

    assert.deepEqual(await queryFnOf<AdminAuditLogRow[]>(eventLogsQuery())(), []);
  });

  it("yields [] for a null body", async () => {
    captureFetch(null);

    assert.deepEqual(await queryFnOf<AdminAuditLogRow[]>(eventLogsQuery())(), []);
  });
});

describe("hostsForLogsQuery", () => {
  it("requests the unfiltered hosts listing and narrows a bare array", async () => {
    const urls = captureFetch([
      { id: 1, fqdn: "edge-01.example", hostname: "edge-01", display_name: "Edge 01", status: "online" },
      { id: 2, hostname: "edge-02", display_name: "Edge 02" },
      { display_name: "Unbound" },
    ]);
    const options = hostsForLogsQuery();

    assert.deepEqual(options.queryKey, ["logs", "hosts-map"]);
    assert.equal(options.staleTime, 60_000);
    assert.deepEqual(await queryFnOf<HostFqdnSummary[]>(options)(), [
      { id: 1, fqdn: "edge-01.example", hostname: "edge-01", display_name: "Edge 01" },
      { id: 2, fqdn: "edge-02", hostname: "edge-02", display_name: "Edge 02" },
      { id: 0, fqdn: null, hostname: null, display_name: "Unbound" },
    ]);
    assert.deepEqual(urls, ["/admin/hosts"]);
  });

  it("reads the {hosts} envelope the endpoint actually serves", async () => {
    captureFetch({ status: "ok", data: { hosts: [{ id: 1, fqdn: "edge-01.example" }] } });

    assert.deepEqual(await queryFnOf<HostFqdnSummary[]>(hostsForLogsQuery())(), [
      { id: 1, fqdn: "edge-01.example", hostname: null, display_name: null },
    ]);
  });

  it("reads an {items} envelope", async () => {
    captureFetch({ items: [{ id: 2, fqdn: "edge-02.example" }] });

    assert.deepEqual(await queryFnOf<HostFqdnSummary[]>(hostsForLogsQuery())(), [
      { id: 2, fqdn: "edge-02.example", hostname: null, display_name: null },
    ]);
  });

  it("yields [] for a payload that is neither an array nor a known envelope", async () => {
    captureFetch({ rows: [{ id: 3, fqdn: "edge-03.example" }] });
    assert.deepEqual(await queryFnOf<HostFqdnSummary[]>(hostsForLogsQuery())(), []);

    captureFetch("edge-03.example");
    assert.deepEqual(await queryFnOf<HostFqdnSummary[]>(hostsForLogsQuery())(), []);
  });
});

describe("buildHostLabelMap", () => {
  it("prefers fqdn, then hostname, then display_name", () => {
    const map = buildHostLabelMap([
      { id: 1, fqdn: "edge-01.example", hostname: "edge-01", display_name: "Edge 01" },
      { id: 2, fqdn: null, hostname: "edge-02", display_name: "Edge 02" },
      { id: 3, fqdn: null, hostname: null, display_name: "Edge 03" },
    ]);

    assert.deepEqual(
      [...map],
      [
        ["1", "edge-01.example"],
        ["2", "edge-02"],
        ["3", "Edge 03"],
      ],
    );
  });

  it("falls back to Host #id when every name is blank or missing", () => {
    const map = buildHostLabelMap([
      { id: 4 },
      { id: "5", fqdn: "", hostname: "", display_name: "" },
      // hostsForLogsQuery hands id-less rows on as 0, which is a real key.
      { id: 0 },
    ]);

    assert.deepEqual(
      [...map],
      [
        ["4", "Host #4"],
        ["5", "Host #5"],
        ["0", "Host #0"],
      ],
    );
  });

  it("skips rows with no id", () => {
    // `HostFqdnSummary` requires an id, so id-less rows only reach this guard
    // from an untyped payload; the cast reproduces one.
    const rows = [
      { id: 1, fqdn: "edge-01.example" },
      { id: null, fqdn: "orphan.example" },
      { fqdn: "ghost.example" },
    ] as unknown as HostFqdnSummary[];

    assert.deepEqual([...buildHostLabelMap(rows)], [["1", "edge-01.example"]]);
  });
});
