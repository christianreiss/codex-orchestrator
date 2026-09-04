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
  chatgptQuotaRows,
  chatgptSeriesLabel,
  claudeUsageQuery,
  claudeHistoryQuery,
  usageKeys,
} = (await import(usageModule)) as typeof import("./usage");

const FIVE_HOURS = 18000;
const ONE_WEEK = 604800;

/** A series carrying `count` points; the values only need to differ in size. */
function seriesOf(key: string, count: number, limitSeconds?: number): ChatGptHistorySeries {
  return {
    key,
    label: key,
    ...(limitSeconds === undefined ? {} : { limit_seconds: limitSeconds }),
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

  it("prefers the longer window in the normal lane", () => {
    const fiveHour = seriesOf("normal_primary", 5, FIVE_HOURS);
    const weekly = seriesOf("normal_secondary", 1, ONE_WEEK);

    assert.equal(pickPrimaryChatgptSeries(historyOf([fiveHour, weekly])), weekly);
  });

  it("does not follow the field position when the weekly window moves to primary", () => {
    // Regression: chatgpt.com moved the normal lane's weekly quota into
    // primary_window on 2026-07-11 and stopped sending a secondary window.
    // The old rule took the first key ending `_secondary` that had any
    // points, so it kept charting a lane whose newest point predated the
    // change while the live weekly numbers arrived on normal_primary.
    const weekly = seriesOf("normal_primary", 40, ONE_WEEK);
    const dead = seriesOf("normal_secondary", 3, FIVE_HOURS);

    assert.equal(pickPrimaryChatgptSeries(historyOf([weekly, dead])), weekly);
  });

  it("prefers the normal lane over a longer spark window", () => {
    const normal = seriesOf("normal_primary", 2, FIVE_HOURS);
    const spark = seriesOf("spark_secondary", 9, ONE_WEEK);

    assert.equal(pickPrimaryChatgptSeries(historyOf([normal, spark])), normal);
  });

  it("skips series with no points, whatever their rank", () => {
    const empty = seriesOf("normal_secondary", 0, ONE_WEEK);
    const spark = seriesOf("spark_primary", 3, FIVE_HOURS);

    assert.equal(pickPrimaryChatgptSeries(historyOf([empty, spark])), spark);
  });

  it("falls back to declaration order when no series reports a window length", () => {
    const primary = seriesOf("normal_primary", 5);
    const secondary = seriesOf("normal_secondary", 1);

    assert.equal(pickPrimaryChatgptSeries(historyOf([primary, secondary])), primary);
  });

  it("returns the first series — empty and all — when no series has points", () => {
    const first = seriesOf("normal_primary", 0);
    const secondary = seriesOf("normal_secondary", 0);

    assert.equal(pickPrimaryChatgptSeries(historyOf([first, secondary])), first);
  });
});

describe("chatgptSeriesLabel", () => {
  it("names the lane and the window's real duration", () => {
    assert.equal(chatgptSeriesLabel(seriesOf("normal_primary", 1, ONE_WEEK)), "Normal · Weekly window");
    assert.equal(chatgptSeriesLabel(seriesOf("spark_primary", 1, FIVE_HOURS)), "Spark · 5-hour window");
  });

  it("keeps the server's own label when the series reports no window length", () => {
    assert.equal(chatgptSeriesLabel(seriesOf("normal_secondary", 1)), "normal_secondary");
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

describe("chatgptQuotaRows", () => {
  // Verbatim `/admin/chatgpt/usage` snapshot for a pro plan, taken from
  // production on 2026-09-04. Since 2026-07-11 chatgpt.com sends the normal
  // lane one window — the weekly one, in the *primary* slot — and a null
  // secondary; the Spark lane still carries both of its windows, at 0%.
  const liveShape = {
    plan_type: "pro",
    primary_window: {
      used_percent: 24,
      limit_seconds: 604800,
      reset_after_seconds: 249774,
      reset_at: null,
      resets_at: null,
    },
    secondary_window: {
      used_percent: null,
      limit_seconds: null,
      reset_after_seconds: null,
      reset_at: null,
      resets_at: null,
    },
    spark_window: {
      primary_window: { used_percent: 0, limit_seconds: 18000, reset_after_seconds: 18000 },
      secondary_window: { used_percent: 0, limit_seconds: 604800, reset_after_seconds: 604800 },
    },
  };

  it("renders no bar for a window the provider stopped reporting", () => {
    // Regression: the card drew one meter per slot, so the absent secondary
    // window became a second bar reading "—", labelled from its positional
    // fallback — which duplicated the "Weekly window" above it.
    const rows = chatgptQuotaRows({ ...liveShape, spark_window: null });

    assert.deepEqual(
      rows.map((row) => row.label),
      ["Weekly window"],
    );
    assert.equal(rows[0]?.usedPercent, 24);
  });

  it("keeps a window sitting at exactly 0%", () => {
    // A truthiness check here would drop both Spark bars, silently: they are
    // normally at 0 and would simply never appear.
    const rows = chatgptQuotaRows(liveShape);

    assert.deepEqual(
      rows.map((row) => row.label),
      ["Weekly window", "Spark · 5-hour window", "Spark · Weekly window"],
    );
    assert.deepEqual(
      rows.map((row) => row.usedPercent),
      [24, 0, 0],
    );
  });

  it("labels each window by its own duration, not its slot", () => {
    const rows = chatgptQuotaRows({
      primary_window: { used_percent: 7, limit_seconds: 604800 },
      secondary_window: { used_percent: 9, limit_seconds: 18000 },
    });

    assert.deepEqual(
      rows.map((row) => row.label),
      ["Weekly window", "5-hour window"],
    );
  });

  it("falls back to the slot's usual duration when the window reports none", () => {
    const rows = chatgptQuotaRows({
      primary_window: { used_percent: 1 },
      secondary_window: { used_percent: 2 },
    });

    assert.deepEqual(
      rows.map((row) => row.label),
      ["5-hour window", "Weekly window"],
    );
  });

  it("returns no rows when every window is absent", () => {
    assert.deepEqual(chatgptQuotaRows({ plan_type: "pro" }), []);
    assert.deepEqual(chatgptQuotaRows(null), []);
  });

  it("reads the normal lane from normal_window when the flat fields are missing", () => {
    const rows = chatgptQuotaRows({
      normal_window: { primary_window: { used_percent: 12, limit_seconds: 604800 } },
    });

    assert.deepEqual(
      rows.map((row) => [row.key, row.label]),
      [["normal_primary", "Weekly window"]],
    );
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
