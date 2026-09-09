import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { registerHooks } from "node:module";

// `transfers.ts` only touches the network through `./client` and the download
// helper, and takes its invalidation handle from svelte-query's
// `useQueryClient`. Stubbing all three — svelte-query's real entry point
// re-exports `.svelte` files node cannot load — keeps every builder importable
// outside the browser and records what each one puts on the wire.
const QUERY_STUB = "stub:svelte-query";
const CLIENT_STUB = "stub:api-client";
const DOWNLOAD_STUB = "stub:download";

const queryStubSource = `
export const invalidations = [];
export function createQuery(options) {
  return options;
}
export function createMutation(options) {
  return options;
}
export function useQueryClient() {
  return {
    invalidateQueries: (filters) => invalidations.push(filters.queryKey),
  };
}
`;

const clientStubSource = `
/** Every request the builders issued, in call order; shared with the test. */
export const calls = [];

const record = (method, path, body) => {
  calls.push({ method, path, body });
  return Promise.resolve({ ok: true });
};

export class ApiError extends Error {}

export const api = {
  get: (path) => record("GET", path, undefined),
  post: (path, body) => record("POST", path, body),
  delete: (path) => record("DELETE", path, undefined),
};
`;

const downloadStubSource = `
export const downloads = [];
export function downloadFile(path, filename) {
  downloads.push({ path, filename });
  return Promise.resolve();
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@tanstack/svelte-query") return { url: QUERY_STUB, shortCircuit: true };
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    if (specifier === "$lib/utils/download") return { url: DOWNLOAD_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === QUERY_STUB) return { format: "module", shortCircuit: true, source: queryStubSource };
    if (url === CLIENT_STUB) return { format: "module", shortCircuit: true, source: clientStubSource };
    if (url === DOWNLOAD_STUB)
      return { format: "module", shortCircuit: true, source: downloadStubSource };
    return nextLoad(url, context);
  },
});

interface RecordedCall {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body: unknown;
}

interface BuiltQuery {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  refetchInterval?: number;
}

interface BuiltMutation {
  mutationFn: (variables: unknown) => Promise<unknown>;
  onSettled?: (...args: unknown[]) => void;
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: RecordedCall[] };

const queryModule: string = QUERY_STUB;
const { invalidations } = (await import(queryModule)) as { invalidations: unknown[][] };

const downloadModule: string = DOWNLOAD_STUB;
const { downloads } = (await import(downloadModule)) as {
  downloads: Array<{ path: string; filename: string }>;
};

const transfersModule: string = "./transfers.ts";
const transfers = (await import(transfersModule)) as typeof import("./transfers");

const asQuery = (built: unknown): BuiltQuery => built as unknown as BuiltQuery;
const asMutation = (built: unknown): BuiltMutation => built as unknown as BuiltMutation;

beforeEach(() => {
  calls.length = 0;
  invalidations.length = 0;
  downloads.length = 0;
});

describe("transfer queries", () => {
  it("reads module state from the state route", async () => {
    const built = asQuery(transfers.transferStateQuery());
    assert.deepEqual(built.queryKey, ["transfers", "state"]);
    await built.queryFn();
    assert.deepEqual(calls, [{ method: "GET", path: "/admin/transfers/state", body: undefined }]);
  });

  it("polls the listing, because every row carries a deadline the server sweeps", async () => {
    const built = asQuery(transfers.transferListQuery());
    assert.deepEqual(built.queryKey, ["transfers", "list"]);
    // Without this a page left open renders swept files as live.
    assert.equal(built.refetchInterval, 30_000);
    await built.queryFn();
    assert.deepEqual(calls, [{ method: "GET", path: "/admin/transfers", body: undefined }]);
  });

  it("keys the audit trail per transfer and stays disabled without one", async () => {
    let id: string | null = null;
    const built = asQuery(transfers.transferEventsQuery(() => id));
    assert.equal((built as unknown as { enabled: boolean }).enabled, false);
    id = "abc";
    assert.deepEqual(built.queryKey, ["transfers", "events", "abc"]);
    assert.equal((built as unknown as { enabled: boolean }).enabled, true);
    await built.queryFn();
    assert.deepEqual(calls, [
      { method: "GET", path: "/admin/transfers/abc/events", body: undefined },
    ]);
  });
});

describe("transfer mutations", () => {
  it("posts the boolean the toggle produces and refreshes the whole module", async () => {
    const built = asMutation(transfers.transferStateMutation());
    await built.mutationFn(true);
    assert.deepEqual(calls, [
      { method: "POST", path: "/admin/transfers/state", body: { enabled: true } },
    ]);
    built.onSettled?.();
    assert.deepEqual(invalidations, [["transfers"]]);
  });

  it("sends the limits as one payload, since the server refuses an incoherent set", async () => {
    const built = asMutation(transfers.transferLimitsMutation());
    await built.mutationFn({ default_ttl_seconds: 600, max_ttl_seconds: 3600 });
    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/admin/transfers/limits",
        body: { default_ttl_seconds: 600, max_ttl_seconds: 3600 },
      },
    ]);
  });

  it("deletes by id", async () => {
    const built = asMutation(transfers.transferDeleteMutation());
    await built.mutationFn("f-1");
    assert.deepEqual(calls, [
      { method: "DELETE", path: "/admin/transfers/f-1", body: undefined },
    ]);
  });

  it("downloads to the uploader's filename and refreshes the now-stale fetch count", async () => {
    const built = asMutation(transfers.transferDownloadMutation());
    await built.mutationFn({ id: "f-2", name: "heap.hprof" });
    assert.deepEqual(downloads, [
      { path: "/admin/transfers/f-2/content", filename: "heap.hprof" },
    ]);
    // Nothing goes through the JSON client: the response is bytes.
    assert.deepEqual(calls, []);
    built.onSettled?.();
    assert.deepEqual(invalidations, [["transfers"]]);
  });
});

describe("presentation helpers", () => {
  it("renders a duration in the largest unit that divides evenly", () => {
    assert.equal(transfers.formatDuration(86_400), "1 day");
    assert.equal(transfers.formatDuration(172_800), "2 days");
    assert.equal(transfers.formatDuration(3600), "1 hour");
    assert.equal(transfers.formatDuration(7200), "2 hours");
    assert.equal(transfers.formatDuration(600), "10 minutes");
    assert.equal(transfers.formatDuration(90), "90 seconds");
  });

  it("names the actor, so the trail reads as who did what", () => {
    const base = {
      id: "e1",
      source_host_id: null,
      detail: null,
      created_at: "2026-09-09T00:00:00Z",
    } as const;
    assert.equal(
      transfers.transferActionLabel({
        ...base,
        action: "uploaded",
        actor_kind: "agent",
        actor_label: "chris",
      }),
      "Uploaded by chris",
    );
    assert.equal(
      transfers.transferActionLabel({
        ...base,
        action: "downloaded",
        actor_kind: "admin",
        actor_label: "7",
      }),
      "Downloaded by admin 7",
    );
    // The sweeper is not a person and must not be rendered as one.
    assert.equal(
      transfers.transferActionLabel({
        ...base,
        action: "expired",
        actor_kind: "system",
        actor_label: "sweeper",
      }),
      "Expired and swept",
    );
    // An agent that did not say who it was still has to render.
    assert.equal(
      transfers.transferActionLabel({
        ...base,
        action: "uploaded",
        actor_kind: "agent",
        actor_label: null,
      }),
      "Uploaded by an agent",
    );
  });
});
