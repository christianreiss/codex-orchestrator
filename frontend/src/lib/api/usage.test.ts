import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

import type { ChatGptHistoryResponse, ChatGptHistorySeries } from "./usage";

// `usage.ts` pulls in the real API client and `@tanstack/svelte-query`, whose
// `createQuery` needs a live Svelte component context; answering both with
// stubs keeps the module importable and hands the query builders' options back
// verbatim so the day count can be read off them.
const CLIENT_STUB = "stub:api-client";
const QUERY_STUB = "stub:svelte-query";

const clientStubSource = `
/** Every path passed to \`api.get\`, in call order; shared with the test. */
export const calls = [];
export const api = {
  get: async (path) => {
    calls.push(path);
    return null;
  },
};
`;

const queryStubSource = `
export const createQuery = (options) => options;
export const createMutation = (options) => options;
export const useQueryClient = () => ({ invalidateQueries: () => {} });
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    if (specifier === "@tanstack/svelte-query") return { url: QUERY_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === CLIENT_STUB) {
      return { format: "module", shortCircuit: true, source: clientStubSource };
    }
    if (url === QUERY_STUB) {
      return { format: "module", shortCircuit: true, source: queryStubSource };
    }
    return nextLoad(url, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: string[] };

const usageModule: string = "./usage.ts";
const {
  chatgptHistoryQuery,
  pickPrimaryChatgptSeries,
  chatgptWindowLabel,
  claudeUsageQuery,
  claudeHistoryQuery,
  usageKeys,
} = (await import(usageModule)) as typeof import("./usage");

/** A series carrying `count` points; the values only need to differ in size. */
function seriesOf(key: string, count: number): ChatGptHistorySeries {
  return {
    key,
    label: key,
    points: Array.from({ length: count }, (_, i) => ({
      ts: `2026-07-0${i + 1}T00:00:00Z`,
      value: i,
    })),
  };
}

function historyOf(series: ChatGptHistorySeries[]): ChatGptHistoryResponse {
  return { days: 60, interval: "day", lane: "both", window: "both", series };
}

/** The options `createQuery` was handed, which the stub returns unchanged. */
function queryOptions(days?: number): { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> } {
  const query = days === undefined ? chatgptHistoryQuery() : chatgptHistoryQuery(days);
  return query as unknown as { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> };
}

describe("pickPrimaryChatgptSeries", () => {
  it("returns null for an undefined history", () => {
    assert.equal(pickPrimaryChatgptSeries(undefined), null);
  });

  it("returns null for an empty series array", () => {
    assert.equal(pickPrimaryChatgptSeries(historyOf([])), null);
  });

  it("prefers a secondary series with points over an earlier, longer primary", () => {
    const primary = seriesOf("normal_primary", 5);
    const secondary = seriesOf("normal_secondary", 1);

    assert.equal(pickPrimaryChatgptSeries(historyOf([primary, secondary])), secondary);
  });

  it("falls through to the first series with points when the secondary is empty", () => {
    const empty = seriesOf("normal_primary", 0);
    const primary = seriesOf("spark_primary", 3);
    const secondary = seriesOf("normal_secondary", 0);

    assert.equal(pickPrimaryChatgptSeries(historyOf([empty, secondary, primary])), primary);
  });

  it("returns the first series — empty and all — when no series has points", () => {
    const first = seriesOf("normal_primary", 0);
    const secondary = seriesOf("normal_secondary", 0);

    assert.equal(pickPrimaryChatgptSeries(historyOf([first, secondary])), first);
  });
});

describe("chatgptWindowLabel", () => {
  // Regression: the dashboard used to hardcode "5-hour window" to the
  // primary_window field and "Weekly window" to secondary_window by
  // position. chatgpt.com doesn't guarantee that mapping — derive the label
  // from the window's own limit_seconds instead, like the cxx CLI does.
  it("labels the 5-hour window by its actual duration, not its field position", () => {
    assert.equal(chatgptWindowLabel(18000, "fallback"), "5-hour window");
  });

  it("labels the weekly window by its actual duration, not its field position", () => {
    assert.equal(chatgptWindowLabel(604800, "fallback"), "Weekly window");
  });

  it("falls back when limit_seconds swaps the usual primary/secondary duration", () => {
    // If chatgpt.com ever hands back a "primary_window" that is actually the
    // weekly lane, the label must follow the duration, not the field name.
    assert.equal(chatgptWindowLabel(604800, "5-hour window"), "Weekly window");
  });

  it("falls back to the caller-supplied label when limit_seconds is missing", () => {
    assert.equal(chatgptWindowLabel(null, "5-hour window"), "5-hour window");
    assert.equal(chatgptWindowLabel(undefined, "Weekly window"), "Weekly window");
  });

  it("describes other day/hour windows generically", () => {
    assert.equal(chatgptWindowLabel(86400, "fallback"), "1-day window");
    assert.equal(chatgptWindowLabel(3600, "fallback"), "1-hour window");
  });
});

describe("chatgptHistoryQuery", () => {
  it("keys and requests the same day count", async () => {
    const options = queryOptions(14);

    assert.deepEqual(options.queryKey, usageKeys.chatgptHistory(14));
    assert.deepEqual(options.queryKey, ["usage", "chatgpt", "history", 14]);

    await options.queryFn();
    assert.equal(calls.at(-1), "/admin/chatgpt/usage/history?days=14&interval=day");
  });

  it("keys and requests the same default day count", async () => {
    const options = queryOptions();

    assert.deepEqual(options.queryKey, usageKeys.chatgptHistory());
    assert.deepEqual(options.queryKey, ["usage", "chatgpt", "history", 60]);

    await options.queryFn();
    assert.equal(calls.at(-1), "/admin/chatgpt/usage/history?days=60&interval=day");
  });
});

describe("claudeUsageQuery", () => {
  it("keys and requests the pushed snapshot, not a fetch/refresh endpoint", async () => {
    const options = claudeUsageQuery() as unknown as {
      queryKey: readonly unknown[];
      queryFn: () => Promise<unknown>;
    };

    assert.deepEqual(options.queryKey, usageKeys.claude);
    assert.deepEqual(options.queryKey, ["usage", "claude"]);

    await options.queryFn();
    assert.equal(calls.at(-1), "/admin/claude/usage");
  });
});

describe("claudeHistoryQuery", () => {
  it("keys and requests the same day count", async () => {
    const options = claudeHistoryQuery(14) as unknown as {
      queryKey: readonly unknown[];
      queryFn: () => Promise<unknown>;
    };

    assert.deepEqual(options.queryKey, usageKeys.claudeHistory(14));
    assert.deepEqual(options.queryKey, ["usage", "claude", "history", 14]);

    await options.queryFn();
    assert.equal(calls.at(-1), "/admin/claude/usage/history?days=14");
  });

  it("keys and requests the same default day count", async () => {
    const options = claudeHistoryQuery() as unknown as {
      queryKey: readonly unknown[];
      queryFn: () => Promise<unknown>;
    };

    assert.deepEqual(options.queryKey, usageKeys.claudeHistory());
    assert.deepEqual(options.queryKey, ["usage", "claude", "history", 60]);

    await options.queryFn();
    assert.equal(calls.at(-1), "/admin/claude/usage/history?days=60");
  });
});
