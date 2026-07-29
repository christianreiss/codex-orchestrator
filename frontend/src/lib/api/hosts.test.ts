import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

import type { HostFilterId } from "./hosts";
import type { HostListItem } from "./types";

// `hosts.ts` pulls in svelte-query (whose entry point re-exports `.svelte`
// files node cannot load) and the real API client; both are only touched
// inside the query/mutation factories, so bare stubs are enough to reach the
// pure helpers at the bottom of the module.
const QUERY_STUB = "stub:svelte-query";
const CLIENT_STUB = "stub:api-client";

const queryStubSource = `
export function createQuery(options) {
  return options;
}
export function createMutation(options) {
  return options;
}
`;

const clientStubSource = `
export class ApiError extends Error {}
export const api = {};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@tanstack/svelte-query") return { url: QUERY_STUB, shortCircuit: true };
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
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

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const hostsModule: string = "./hosts.ts";
const {
  HOST_ONLINE_WINDOW_MS,
  hostCxxWrapperState,
  hostEngines,
  hostHasRequiredAuth,
  hostLastSeenMs,
  hostLatestRefresh,
  hostLatestRefreshMs,
  hostMatchesFilter,
  hostStatusKind,
  hostStatusLabel,
  isInsecureWindowActive,
} = (await import(hostsModule)) as typeof import("./hosts");

/** Fixed reference point for the assertions that drive the online window themselves. */
const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** A healthy codex-only host, seen just now. Tests override what they exercise. */
function makeHost(overrides: Partial<HostListItem> = {}): HostListItem {
  return {
    id: 1,
    fqdn: "host.example.com",
    status: "ok",
    last_refresh: null,
    claude_last_refresh: null,
    updated_at: new Date().toISOString(),
    created_at: null,
    client_version: null,
    claude_client_version: null,
    client_version_override: null,
    claude_client_version_override: null,
    agents_document_id_override: null,
    wrapper_version: null,
    claude_wrapper_version: null,
    api_calls: null,
    ip4: null,
    ip6: null,
    allow_roaming_ips: false,
    secure: true,
    vip: false,
    insecure_enabled_until: null,
    insecure_grace_until: null,
    insecure_window_minutes: null,
    curl_insecure: false,
    browseros_mcp_enabled: false,
    last_cron_check: null,
    reverse_dns_mode: null,
    lane_preference: null,
    model_override: null,
    reasoning_effort_override: null,
    claude_model_override: null,
    claude_reasoning_effort_override: null,
    engines: "codex",
    engines_list: ["codex"],
    auto_update_override: null,
    effective_auto_update_enabled: false,
    auto_update_state: "unknown",
    auto_update_label: null,
    auto_update_emoji: null,
    auto_update_rank: null,
    auto_update_last_event_at: null,
    auto_update_target_version: null,
    canonical_digest: "sha256:codex",
    claude_canonical_digest: null,
    recent_digests: [],
    claude_recent_digests: [],
    authed: true,
    auth_outdated: false,
    auth_source: false,
    users: [],
    ...overrides,
  };
}

describe("hostCxxWrapperState", () => {
  it("renders one shared version when both engine reports agree", () => {
    assert.deepEqual(
      hostCxxWrapperState(
        makeHost({
          engines: "codex,claude",
          engines_list: ["codex", "claude"],
          wrapper_version: "0.7.0",
          claude_wrapper_version: "0.7.0",
        }),
      ),
      { display: "0.7.0", drift: false },
    );
  });

  it("labels mismatched dual-engine telemetry as migration drift", () => {
    assert.deepEqual(
      hostCxxWrapperState(
        makeHost({
          engines: "codex,claude",
          engines_list: ["codex", "claude"],
          wrapper_version: "0.7.0",
          claude_wrapper_version: "0.6.55",
        }),
      ),
      {
        display: "Codex 0.7.0 · Claude 0.6.55 (migration drift)",
        drift: true,
      },
    );
  });

  it("does not invent drift for a single-engine host", () => {
    assert.deepEqual(
      hostCxxWrapperState(
        makeHost({ wrapper_version: "0.7.0", claude_wrapper_version: "0.6.55" }),
      ),
      { display: "0.7.0", drift: false },
    );
  });
});

describe("isInsecureWindowActive", () => {
  it("is false for a secure host even with a live deadline", () => {
    assert.equal(
      isInsecureWindowActive({ secure: true, insecure_enabled_until: iso(Date.now() + 60_000) }),
      false,
    );
  });

  it("is false when no deadline is set", () => {
    assert.equal(isInsecureWindowActive({ secure: false, insecure_enabled_until: null }), false);
    assert.equal(isInsecureWindowActive({ secure: false }), false);
  });

  it("is false when the deadline does not parse", () => {
    assert.equal(
      isInsecureWindowActive({ secure: false, insecure_enabled_until: "whenever" }),
      false,
    );
  });

  it("is false for a deadline in the past and true for one in the future", () => {
    assert.equal(
      isInsecureWindowActive({ secure: false, insecure_enabled_until: iso(Date.now() - 1_000) }),
      false,
    );
    assert.equal(
      isInsecureWindowActive({ secure: false, insecure_enabled_until: iso(Date.now() + 60_000) }),
      true,
    );
  });
});

describe("hostEngines", () => {
  it("prefers the structured list over the comma string", () => {
    assert.deepEqual(hostEngines({ engines_list: ["claude"], engines: "codex" }), ["claude"]);
  });

  it("falls back to the comma string, trimming each entry", () => {
    assert.deepEqual(hostEngines({ engines_list: [], engines: " codex , claude " }), [
      "codex",
      "claude",
    ]);
  });

  it("is empty when neither carries an engine", () => {
    assert.deepEqual(hostEngines({ engines_list: [], engines: "" }), []);
    assert.deepEqual(hostEngines({ engines_list: [], engines: "   " }), []);
  });
});

describe("hostLatestRefresh", () => {
  const codex = "2026-07-20T08:00:00.000Z";
  const claude = "2026-07-21T08:00:00.000Z";

  it("picks the newer of the two mint times", () => {
    assert.equal(
      hostLatestRefreshMs({ last_refresh: codex, claude_last_refresh: claude }),
      Date.parse(claude),
    );
    assert.equal(
      hostLatestRefreshMs({ last_refresh: claude, claude_last_refresh: codex }),
      Date.parse(claude),
    );
    assert.equal(hostLatestRefresh({ last_refresh: codex, claude_last_refresh: claude }), claude);
  });

  it("breaks a tie towards codex and hands back the original string form", () => {
    const offset = "2026-07-20T10:00:00+02:00";
    assert.equal(
      hostLatestRefresh({ last_refresh: offset, claude_last_refresh: codex }),
      offset,
      "same instant written differently still resolves to the codex spelling",
    );
    assert.equal(
      hostLatestRefresh({ last_refresh: claude, claude_last_refresh: null }),
      claude,
      "the stored string is returned verbatim, not a re-serialized date",
    );
  });

  it("falls through to claude when only it parses", () => {
    assert.equal(hostLatestRefresh({ last_refresh: "never", claude_last_refresh: claude }), claude);
    assert.equal(
      hostLatestRefreshMs({ last_refresh: "never", claude_last_refresh: claude }),
      Date.parse(claude),
    );
  });

  it("is null when neither parses", () => {
    assert.equal(hostLatestRefresh({ last_refresh: null, claude_last_refresh: null }), null);
    assert.equal(hostLatestRefresh({ last_refresh: "never", claude_last_refresh: "" }), null);
    assert.equal(hostLatestRefreshMs({ last_refresh: "never", claude_last_refresh: null }), null);
  });
});

describe("hostLastSeenMs", () => {
  const older = "2026-07-20T08:00:00.000Z";
  const newer = "2026-07-25T08:00:00.000Z";

  it("takes the newest of the three timestamps", () => {
    assert.equal(
      hostLastSeenMs({ updated_at: newer, last_refresh: older, claude_last_refresh: older }),
      Date.parse(newer),
    );
    assert.equal(
      hostLastSeenMs({ updated_at: older, last_refresh: newer, claude_last_refresh: older }),
      Date.parse(newer),
    );
    assert.equal(
      hostLastSeenMs({ updated_at: older, last_refresh: older, claude_last_refresh: newer }),
      Date.parse(newer),
    );
  });

  it("is null when none of them parse", () => {
    assert.equal(
      hostLastSeenMs({ updated_at: null, last_refresh: "never", claude_last_refresh: null }),
      null,
    );
  });
});

describe("hostHasRequiredAuth", () => {
  const digests = { canonical_digest: "sha256:codex", claude_canonical_digest: "sha256:claude" };

  it("is false whenever the backend already says unauthed", () => {
    assert.equal(
      hostHasRequiredAuth({
        engines_list: ["codex"],
        engines: "codex",
        authed: false,
        ...digests,
      }),
      false,
    );
  });

  it("treats an engine-less host as codex-only", () => {
    assert.equal(
      hostHasRequiredAuth({
        engines_list: [],
        engines: "",
        authed: true,
        canonical_digest: "sha256:codex",
        claude_canonical_digest: null,
      }),
      true,
    );
    assert.equal(
      hostHasRequiredAuth({
        engines_list: [],
        engines: "",
        authed: true,
        canonical_digest: null,
        claude_canonical_digest: "sha256:claude",
      }),
      false,
    );
  });

  it("checks only the codex digest for a codex-only host", () => {
    const codexOnly = { engines_list: ["codex"] as string[], engines: "codex", authed: true };
    assert.equal(
      hostHasRequiredAuth({
        ...codexOnly,
        canonical_digest: "sha256:codex",
        claude_canonical_digest: null,
      }),
      true,
    );
    assert.equal(
      hostHasRequiredAuth({
        ...codexOnly,
        canonical_digest: null,
        claude_canonical_digest: "sha256:claude",
      }),
      false,
    );
  });

  it("checks only the claude digest for a claude-only host", () => {
    const claudeOnly = { engines_list: ["claude"] as string[], engines: "claude", authed: true };
    assert.equal(
      hostHasRequiredAuth({
        ...claudeOnly,
        canonical_digest: null,
        claude_canonical_digest: "sha256:claude",
      }),
      true,
    );
    assert.equal(
      hostHasRequiredAuth({
        ...claudeOnly,
        canonical_digest: "sha256:codex",
        claude_canonical_digest: null,
      }),
      false,
      "a codex digest must not vouch for a claude host",
    );
  });

  it("demands both digests from a dual-engine host", () => {
    const dual = {
      engines_list: ["codex", "claude"] as string[],
      engines: "codex,claude",
      authed: true,
    };
    assert.equal(hostHasRequiredAuth({ ...dual, ...digests }), true);
    assert.equal(
      hostHasRequiredAuth({ ...dual, canonical_digest: "sha256:codex", claude_canonical_digest: null }),
      false,
    );
    assert.equal(
      hostHasRequiredAuth({ ...dual, canonical_digest: null, claude_canonical_digest: "sha256:claude" }),
      false,
    );
    assert.equal(
      hostHasRequiredAuth({ ...dual, canonical_digest: null, claude_canonical_digest: null }),
      false,
    );
  });

  it("has no digest to demand for an engine it does not know", () => {
    assert.equal(
      hostHasRequiredAuth({
        engines_list: ["gemini"],
        engines: "gemini",
        authed: true,
        canonical_digest: null,
        claude_canonical_digest: null,
      }),
      true,
    );
  });
});

describe("hostStatusKind", () => {
  it("short-circuits on a textual status before anything else is consulted", () => {
    for (const status of ["offline", "stale", "disabled", "OFFLINE"]) {
      assert.equal(hostStatusKind(makeHost({ status })), "offline", status);
    }
  });

  it("reports auth-missing ahead of auth-outdated", () => {
    const host = makeHost({ canonical_digest: null, auth_outdated: true });
    assert.equal(hostStatusKind(host), "auth-missing");
  });

  it("reports auth-outdated ahead of online", () => {
    const host = makeHost({ auth_outdated: true });
    assert.equal(hostStatusKind(host), "auth-outdated");
  });

  it("is online exactly at the edge of the window and offline one ms past it", () => {
    const host = makeHost({ updated_at: iso(NOW - HOST_ONLINE_WINDOW_MS) });
    assert.equal(hostStatusKind(host, NOW), "online");
    assert.equal(hostStatusKind(host, NOW + 1), "offline");
  });

  it("is offline when the host was never seen", () => {
    assert.equal(hostStatusKind(makeHost({ updated_at: null })), "offline");
  });

  it("keeps a host with a stale mint time online while it still checks in", () => {
    const host = makeHost({
      updated_at: iso(NOW - 60_000),
      last_refresh: iso(NOW - 10 * HOST_ONLINE_WINDOW_MS),
    });
    assert.equal(hostStatusKind(host, NOW), "online");
  });
});

describe("hostStatusLabel", () => {
  it("renders each of the four kinds", () => {
    assert.equal(hostStatusLabel(makeHost()), "Online");
    assert.equal(hostStatusLabel(makeHost({ status: "offline" })), "Offline");
    assert.equal(hostStatusLabel(makeHost({ canonical_digest: null })), "Auth missing");
    assert.equal(hostStatusLabel(makeHost({ auth_outdated: true })), "Outdated auth");
  });
});

describe("hostMatchesFilter", () => {
  it("passes everything through the all chip and any unknown chip", () => {
    const host = makeHost({ status: "offline" });
    const unknown: string = "bogus";
    assert.equal(hostMatchesFilter(host, "all"), true);
    assert.equal(hostMatchesFilter(host, unknown as HostFilterId), true);
  });

  it("splits the online and offline chips by status kind", () => {
    const online = makeHost();
    const offline = makeHost({ status: "offline" });
    assert.equal(hostMatchesFilter(online, "online"), true);
    assert.equal(hostMatchesFilter(online, "offline"), false);
    assert.equal(hostMatchesFilter(offline, "offline"), true);
    assert.equal(hostMatchesFilter(offline, "online"), false);
  });

  it("leaves an auth-missing host out of both the online and the offline chip", () => {
    const host = makeHost({ canonical_digest: null });
    assert.equal(hostMatchesFilter(host, "online"), false);
    assert.equal(hostMatchesFilter(host, "offline"), false);
    assert.equal(hostMatchesFilter(host, "unprovisioned"), true);
  });

  it("matches the secure chip on the flag alone", () => {
    assert.equal(hostMatchesFilter(makeHost({ secure: true }), "secure"), true);
    assert.equal(hostMatchesFilter(makeHost({ secure: false }), "secure"), false);
  });

  it("matches the insecure chip on either arm of the disjunction", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal(hostMatchesFilter(makeHost({ secure: false }), "insecure"), true);
    assert.equal(
      hostMatchesFilter(makeHost({ secure: false, insecure_enabled_until: future }), "insecure"),
      true,
    );
    // The window arm only ever fires for a host that is already non-secure —
    // `isInsecureWindowActive` bails out on `secure`, so a secure host with a
    // live deadline stays out of the chip.
    assert.equal(
      hostMatchesFilter(makeHost({ secure: true, insecure_enabled_until: future }), "insecure"),
      false,
    );
  });

  it("matches the unprovisioned chip on missing auth", () => {
    assert.equal(hostMatchesFilter(makeHost(), "unprovisioned"), false);
    assert.equal(hostMatchesFilter(makeHost({ authed: false }), "unprovisioned"), true);
  });

  it("matches the vip and roaming chips on their flags", () => {
    assert.equal(hostMatchesFilter(makeHost({ vip: true }), "vip"), true);
    assert.equal(hostMatchesFilter(makeHost({ vip: false }), "vip"), false);
    assert.equal(hostMatchesFilter(makeHost({ allow_roaming_ips: true }), "roaming"), true);
    assert.equal(hostMatchesFilter(makeHost({ allow_roaming_ips: false }), "roaming"), false);
  });
});
