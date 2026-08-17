import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

// `settings.ts` only ever touches the network through `./client`, and takes its
// invalidation handle from svelte-query (whose entry point re-exports `.svelte`
// files node cannot load). Stubbing both keeps every builder importable outside
// the browser and records what each one puts on the wire and which keys it
// invalidates.
const QUERY_STUB = "stub:svelte-query";
const CLIENT_STUB = "stub:api-client";

const queryStubSource = `
/** Every key handed to invalidateQueries, in call order; shared with the test. */
export const invalidations = [];

export function createQuery(options) {
  return options;
}
export function createMutation(options) {
  return options;
}
export function useQueryClient() {
  return {
    invalidateQueries(filters) {
      invalidations.push(filters.queryKey);
    },
  };
}
`;

const clientStubSource = `
/** Every request the builders issued, in call order; shared with the test. */
export const calls = [];

const record = (method, path, body) => {
  calls.push({ method, path, body });
  return Promise.resolve(null);
};

export const api = {
  get: (path) => record("GET", path, undefined),
  post: (path, body) => record("POST", path, body),
};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@tanstack/svelte-query") return { url: QUERY_STUB, shortCircuit: true };
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    // `settings.ts` imports `./claudeSettings` the way the bundler resolves it,
    // without the extension node insists on.
    if (specifier.startsWith("./") && !specifier.endsWith(".ts")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === QUERY_STUB) {
      return { format: "module", shortCircuit: true, source: queryStubSource };
    }
    if (url === CLIENT_STUB) {
      return { format: "module", shortCircuit: true, source: clientStubSource };
    }
    return nextLoad(url, context);
  },
});

interface RecordedCall {
  method: "GET" | "POST";
  path: string;
  body: unknown;
}

/** What the stubbed `createQuery` hands back in place of a store. */
interface BuiltQuery {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  staleTime?: number;
}

/** What the stubbed `createMutation` hands back in place of a store. */
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

const settingsModule: string = "./settings.ts";
const settings = (await import(settingsModule)) as typeof import("./settings");

const claudeSettingsModule: string = "./claudeSettings.ts";
const { claudeSettingsKeys } = (await import(
  claudeSettingsModule
)) as typeof import("./claudeSettings");

const asQuery = (built: unknown): BuiltQuery => built as unknown as BuiltQuery;
const asMutation = (built: unknown): BuiltMutation => built as unknown as BuiltMutation;

/**
 * The `['settings', '<slug>']` key of each pair, written once so a query case
 * and its mutation case cannot drift apart in the table below.
 */
const KEYS = {
  apiState: ["settings", "api-state"],
  openaiState: ["settings", "openai-state"],
  claudeState: ["settings", "claude-state"],
  claudeSettings: ["settings", "claude-settings"],
  modelDefaultsCodex: ["settings", "model-defaults", "codex"],
  modelDefaultsClaude: ["settings", "model-defaults", "claude"],
  versionsCheck: ["settings", "versions-check"],
  reverseDns: ["settings", "reverse-dns"],
  autoUpdate: ["settings", "auto-update"],
  apiKeysInChat: ["settings", "api-keys-in-chat"],
  cdxSilent: ["settings", "cdx-silent"],
  insecureApproval: ["settings", "insecure-approval"],
  quotaMode: ["settings", "quota-mode"],
  scaling: ["settings", "scaling"],
  logRetention: ["settings", "log-retention"],
  authorization: ["settings", "authorization"],
} as const;

interface QueryCase {
  /** The exported builder, as the guard test matches it. */
  name: string;
  label?: string;
  build: () => BuiltQuery;
  queryKey: readonly unknown[];
  method: "GET" | "POST";
  path: string;
}

const QUERY_CASES: QueryCase[] = [
  {
    name: "authorizationQuery",
    build: () => asQuery(settings.authorizationQuery()),
    queryKey: KEYS.authorization,
    method: "GET",
    path: "/admin/authorization",
  },
  {
    name: "apiStateQuery",
    build: () => asQuery(settings.apiStateQuery()),
    queryKey: KEYS.apiState,
    method: "GET",
    path: "/admin/api/state",
  },
  {
    name: "openaiStateQuery",
    build: () => asQuery(settings.openaiStateQuery()),
    queryKey: KEYS.openaiState,
    method: "GET",
    path: "/admin/openai/state",
  },
  {
    name: "claudeStateQuery",
    build: () => asQuery(settings.claudeStateQuery()),
    queryKey: KEYS.claudeState,
    method: "GET",
    path: "/admin/claude/state",
  },
  {
    name: "claudeSettingsQuery",
    build: () => asQuery(settings.claudeSettingsQuery()),
    queryKey: KEYS.claudeSettings,
    method: "GET",
    path: "/admin/claude/settings",
  },
  {
    name: "modelDefaultsQuery",
    label: "modelDefaultsQuery('codex')",
    build: () => asQuery(settings.modelDefaultsQuery("codex")),
    queryKey: KEYS.modelDefaultsCodex,
    method: "GET",
    path: "/admin/model-defaults/codex",
  },
  {
    name: "modelDefaultsQuery",
    label: "modelDefaultsQuery('claude')",
    build: () => asQuery(settings.modelDefaultsQuery("claude")),
    queryKey: KEYS.modelDefaultsClaude,
    method: "GET",
    path: "/admin/model-defaults/claude",
  },
  {
    name: "claudeVersionsQuery",
    build: () => asQuery(settings.claudeVersionsQuery()),
    queryKey: KEYS.versionsCheck,
    method: "POST",
    path: "/admin/versions/check",
  },
  {
    name: "codexVersionsQuery",
    build: () => asQuery(settings.codexVersionsQuery()),
    queryKey: KEYS.versionsCheck,
    method: "POST",
    path: "/admin/versions/check",
  },
  {
    name: "reverseDnsQuery",
    build: () => asQuery(settings.reverseDnsQuery()),
    queryKey: KEYS.reverseDns,
    method: "GET",
    path: "/admin/reverse-dns",
  },
  {
    name: "autoUpdateQuery",
    build: () => asQuery(settings.autoUpdateQuery()),
    queryKey: KEYS.autoUpdate,
    method: "GET",
    path: "/admin/auto-update",
  },
  {
    name: "cdxSilentQuery",
    build: () => asQuery(settings.cdxSilentQuery()),
    queryKey: KEYS.cdxSilent,
    method: "GET",
    path: "/admin/cdx-silent",
  },
  {
    name: "apiKeysInChatQuery",
    build: () => asQuery(settings.apiKeysInChatQuery()),
    queryKey: KEYS.apiKeysInChat,
    method: "GET",
    path: "/admin/api-keys-in-chat",
  },
  {
    name: "insecureApprovalQuery",
    build: () => asQuery(settings.insecureApprovalQuery()),
    queryKey: KEYS.insecureApproval,
    method: "GET",
    path: "/admin/insecure-approval",
  },
  {
    name: "quotaModeQuery",
    build: () => asQuery(settings.quotaModeQuery()),
    queryKey: KEYS.quotaMode,
    method: "GET",
    path: "/admin/quota-mode",
  },
  {
    name: "scalingQuery",
    build: () => asQuery(settings.scalingQuery()),
    queryKey: KEYS.scaling,
    method: "GET",
    path: "/admin/scaling",
  },
  {
    name: "logRetentionQuery",
    build: () => asQuery(settings.logRetentionQuery()),
    queryKey: KEYS.logRetention,
    method: "GET",
    path: "/admin/log-retention",
  },
];

type OnSettledSpy = (...args: unknown[]) => void;

interface MutationCase {
  /** The exported builder, as the guard test matches it. */
  name: string;
  label?: string;
  build: (opts: { onSettled: OnSettledSpy }) => BuiltMutation;
  variables: unknown;
  request: RecordedCall;
  /** The keys `onSettled` must invalidate, in order — empty for a write-only setting. */
  invalidates: readonly (readonly unknown[])[];
}

const MUTATION_CASES: MutationCase[] = [
  {
    // Switching the posture changes what this very session may do, so it has
    // to invalidate the auth status alongside its own key or the console keeps
    // rendering the capabilities it held a moment ago.
    name: "authorizationMutation",
    build: (opts) => asMutation(settings.authorizationMutation(opts)),
    variables: "strict",
    request: { method: "POST", path: "/admin/authorization", body: { mode: "strict" } },
    invalidates: [KEYS.authorization, ["auth", "status"]],
  },
  {
    name: "apiStateMutation",
    build: (opts) => asMutation(settings.apiStateMutation(opts)),
    variables: true,
    request: { method: "POST", path: "/admin/api/state", body: { disabled: true } },
    invalidates: [KEYS.apiState],
  },
  {
    name: "openaiStateMutation",
    build: (opts) => asMutation(settings.openaiStateMutation(opts)),
    variables: false,
    request: { method: "POST", path: "/admin/openai/state", body: { disabled: false } },
    invalidates: [KEYS.openaiState],
  },
  {
    name: "claudeStateMutation",
    build: (opts) => asMutation(settings.claudeStateMutation(opts)),
    variables: true,
    request: { method: "POST", path: "/admin/claude/state", body: { disabled: true } },
    invalidates: [KEYS.claudeState],
  },
  {
    name: "claudeSettingsMutation",
    build: (opts) => asMutation(settings.claudeSettingsMutation(opts)),
    variables: { default_model: "opus" },
    request: {
      method: "POST",
      path: "/admin/claude/settings",
      body: { default_model: "opus" },
    },
    invalidates: [KEYS.claudeSettings],
  },
  {
    name: "modelDefaultsMutation",
    label: "modelDefaultsMutation('codex')",
    build: (opts) => asMutation(settings.modelDefaultsMutation("codex", opts)),
    variables: { model: "gpt-5", reasoning_effort: "high" },
    request: {
      method: "POST",
      path: "/admin/model-defaults/codex",
      body: { model: "gpt-5", reasoning_effort: "high" },
    },
    invalidates: [KEYS.modelDefaultsCodex],
  },
  {
    name: "modelDefaultsMutation",
    label: "modelDefaultsMutation('claude')",
    build: (opts) => asMutation(settings.modelDefaultsMutation("claude", opts)),
    variables: { model: "opus", reasoning_effort: null },
    request: {
      method: "POST",
      path: "/admin/model-defaults/claude",
      body: { model: "opus", reasoning_effort: null },
    },
    // The claude defaults also live in the settings.json block the Claude
    // config query reads, so that key rides along — codex has no counterpart.
    invalidates: [KEYS.modelDefaultsClaude, claudeSettingsKeys.config()],
  },
  {
    name: "claudeVersionsCheckMutation",
    build: (opts) => asMutation(settings.claudeVersionsCheckMutation(opts)),
    variables: undefined,
    request: { method: "POST", path: "/admin/versions/check", body: undefined },
    invalidates: [KEYS.versionsCheck],
  },
  {
    name: "claudeVersionMutation",
    build: (opts) => asMutation(settings.claudeVersionMutation(opts)),
    variables: "1.2.3",
    request: {
      method: "POST",
      path: "/admin/claude/version",
      body: { selection: "1.2.3" },
    },
    invalidates: [KEYS.versionsCheck],
  },
  {
    name: "reverseDnsMutation",
    build: (opts) => asMutation(settings.reverseDnsMutation(opts)),
    variables: true,
    request: { method: "POST", path: "/admin/reverse-dns", body: { enabled: true } },
    invalidates: [KEYS.reverseDns],
  },
  {
    name: "autoUpdateMutation",
    build: (opts) => asMutation(settings.autoUpdateMutation(opts)),
    variables: false,
    request: { method: "POST", path: "/admin/auto-update", body: { enabled: false } },
    invalidates: [KEYS.autoUpdate],
  },
  {
    name: "cdxSilentMutation",
    build: (opts) => asMutation(settings.cdxSilentMutation(opts)),
    variables: true,
    request: { method: "POST", path: "/admin/cdx-silent", body: { silent: true } },
    invalidates: [KEYS.cdxSilent],
  },
  {
    name: "apiKeysInChatMutation",
    build: (opts) => asMutation(settings.apiKeysInChatMutation(opts)),
    variables: true,
    request: { method: "POST", path: "/admin/api-keys-in-chat", body: { enabled: true } },
    invalidates: [KEYS.apiKeysInChat],
  },
  {
    name: "insecureApprovalMutation",
    build: (opts) => asMutation(settings.insecureApprovalMutation(opts)),
    variables: true,
    request: { method: "POST", path: "/admin/insecure-approval", body: { enabled: true } },
    invalidates: [KEYS.insecureApproval],
  },
  {
    name: "quotaModeMutation",
    build: (opts) => asMutation(settings.quotaModeMutation(opts)),
    variables: { hard_fail: true, limit_percent: 90 },
    request: {
      method: "POST",
      path: "/admin/quota-mode",
      body: { hard_fail: true, limit_percent: 90 },
    },
    invalidates: [KEYS.quotaMode],
  },
  {
    name: "codexVersionsCheckMutation",
    build: (opts) => asMutation(settings.codexVersionsCheckMutation(opts)),
    variables: undefined,
    request: { method: "POST", path: "/admin/versions/check", body: undefined },
    invalidates: [KEYS.versionsCheck],
  },
  {
    name: "codexVersionMutation",
    build: (opts) => asMutation(settings.codexVersionMutation(opts)),
    variables: "latest",
    // Not `/admin/codex/version` -- the codex lock predates the claude one and
    // keeps its flat path.
    request: {
      method: "POST",
      path: "/admin/codex-version",
      body: { selection: "latest" },
    },
    invalidates: [KEYS.versionsCheck],
  },
  {
    name: "scalingMutation",
    build: (opts) => asMutation(settings.scalingMutation(opts)),
    variables: { enabled: true },
    request: { method: "POST", path: "/admin/scaling", body: { enabled: true } },
    invalidates: [KEYS.scaling],
  },
  {
    name: "prunePolicyMutation",
    build: (opts) => asMutation(settings.prunePolicyMutation(opts)),
    variables: { inactivity_days: 30 },
    request: {
      method: "POST",
      path: "/admin/prune-policy",
      body: { inactivity_days: 30 },
    },
    // No GET endpoint exists, so there is no paired key to invalidate.
    invalidates: [],
  },
  {
    name: "logRetentionMutation",
    build: (opts) => asMutation(settings.logRetentionMutation(opts)),
    variables: { enabled: true, days_logs: 14 },
    request: {
      method: "POST",
      path: "/admin/log-retention",
      body: { enabled: true, days_logs: 14 },
    },
    invalidates: [KEYS.logRetention],
  },
];

beforeEach(() => {
  calls.length = 0;
  invalidations.length = 0;
});

describe("query builders", () => {
  for (const queryCase of QUERY_CASES) {
    it(`${queryCase.label ?? queryCase.name} keys and reads ${queryCase.path}`, async () => {
      const built = queryCase.build();
      assert.deepEqual(built.queryKey, queryCase.queryKey);

      await built.queryFn();
      assert.deepEqual(calls, [
        { method: queryCase.method, path: queryCase.path, body: undefined },
      ]);
    });
  }

  it("registers both engines' version reads under the one shared key", () => {
    assert.equal(settings.claudeVersionsQueryKey, settings.versionsCheckQueryKey);
    assert.equal(settings.codexVersionsQueryKey, settings.versionsCheckQueryKey);
    // The shared key is only safe because neither read re-triggers the forced
    // upstream probe on a stale remount.
    assert.equal(asQuery(settings.claudeVersionsQuery()).staleTime, Infinity);
    assert.equal(asQuery(settings.codexVersionsQuery()).staleTime, Infinity);
  });
});

describe("mutation builders", () => {
  for (const mutationCase of MUTATION_CASES) {
    const label = mutationCase.label ?? mutationCase.name;

    it(`${label} writes ${mutationCase.request.path}`, async () => {
      const built = mutationCase.build({ onSettled: () => {} });
      await built.mutationFn(mutationCase.variables);
      assert.deepEqual(calls, [mutationCase.request]);
    });

    it(`${label} invalidates its paired key and forwards onSettled`, () => {
      const forwarded: unknown[][] = [];
      const built = mutationCase.build({
        onSettled: (...args) => {
          forwarded.push(args);
        },
      });

      const settledArgs = [{ ok: true }, null, mutationCase.variables, "context"];
      built.onSettled?.(...settledArgs);

      assert.deepEqual(invalidations, mutationCase.invalidates);
      assert.deepEqual(forwarded, [settledArgs], "the caller's onSettled still runs");
    });
  }
});

describe("module surface", () => {
  /** Every runtime export, so a new pair cannot slip past the tables above. */
  const EXPECTED_EXPORTS = [
    "apiKeysInChatMutation",
    "apiKeysInChatQuery",
    "apiKeysInChatQueryKey",
    "apiStateMutation",
    "apiStateQuery",
    "apiStateQueryKey",
    "authorizationMutation",
    "authorizationQuery",
    "authorizationQueryKey",
    "autoUpdateMutation",
    "autoUpdateQuery",
    "autoUpdateQueryKey",
    "cdxSilentMutation",
    "cdxSilentQuery",
    "cdxSilentQueryKey",
    "claudeSettingsMutation",
    "claudeSettingsQuery",
    "claudeSettingsQueryKey",
    "claudeStateMutation",
    "claudeStateQuery",
    "claudeStateQueryKey",
    "claudeVersionMutation",
    "claudeVersionsCheckMutation",
    "claudeVersionsQuery",
    "claudeVersionsQueryKey",
    "codexVersionMutation",
    "codexVersionsCheckMutation",
    "codexVersionsQuery",
    "codexVersionsQueryKey",
    "insecureApprovalMutation",
    "insecureApprovalQuery",
    "insecureApprovalQueryKey",
    "logRetentionMutation",
    "logRetentionQuery",
    "logRetentionQueryKey",
    "modelDefaultsMutation",
    "modelDefaultsQuery",
    "modelDefaultsQueryKey",
    "openaiStateMutation",
    "openaiStateQuery",
    "openaiStateQueryKey",
    "prunePolicyMutation",
    "quotaModeMutation",
    "quotaModeQuery",
    "quotaModeQueryKey",
    "reverseDnsMutation",
    "reverseDnsQuery",
    "reverseDnsQueryKey",
    "scalingMutation",
    "scalingQuery",
    "scalingQueryKey",
    "versionsCheckQueryKey",
  ];

  it("exports exactly the documented surface", () => {
    assert.deepEqual(Object.keys(settings).sort(), EXPECTED_EXPORTS);
  });

  it("drives every exported query and mutation builder", () => {
    const driven = new Set([...QUERY_CASES, ...MUTATION_CASES].map((testCase) => testCase.name));
    const exported = Object.keys(settings).filter(
      (name) => name.endsWith("Query") || name.endsWith("Mutation"),
    );

    assert.deepEqual(
      exported.filter((name) => !driven.has(name)),
      [],
      "every builder needs a case in QUERY_CASES or MUTATION_CASES",
    );
    assert.deepEqual(
      [...driven].filter((name) => !exported.includes(name)),
      [],
      "every case must name a builder the module still exports",
    );
  });
});
