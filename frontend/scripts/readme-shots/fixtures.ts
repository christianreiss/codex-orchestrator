/**
 * One coherent, documentation-safe demo fleet for the README screenshots.
 *
 * Every hostname lives under example.net, every address is in a
 * documentation range, and every key is a visibly fake prefix. Response
 * shapes follow the e2e fixtures in ../../e2e and the types in
 * ../../src/lib/api; a path this file does not know answers
 * `{ status: "ok" }` and is reported by capture.ts so gaps are visible.
 */

import { CAPABILITIES } from "../../src/lib/auth/capabilities.ts";

const NOW = Date.now();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const ahead = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

const user = { id: 1, username: "ada", name: "Ada Operator", access_level: "owner", roles: ["owner"] };

const CODEX = "0.158.0";
const CLAUDE = "2.1.184";
const WRAPPER = "0.9.12";

interface DemoHost {
  id: number;
  fqdn: string;
  engines: string;
  secure?: boolean;
  vip?: boolean;
  codex?: string | null;
  claude?: string | null;
  seen: number;
  outdated?: boolean;
  ip4: string;
}

const HOSTS: DemoHost[] = [
  { id: 1, fqdn: "atlas.example.net", engines: "codex,claude", vip: true, seen: 40, ip4: "192.0.2.10" },
  { id: 2, fqdn: "crane.example.net", engines: "codex,claude", seen: 95, ip4: "192.0.2.11" },
  { id: 3, fqdn: "forge.example.net", engines: "codex", seen: 300, ip4: "192.0.2.12" },
  { id: 4, fqdn: "harbor.example.net", engines: "claude", seen: 620, ip4: "192.0.2.13" },
  { id: 5, fqdn: "build-02.example.net", engines: "codex,claude", seen: 1800, codex: "0.156.0", ip4: "198.51.100.4" },
  { id: 6, fqdn: "nova.example.net", engines: "codex", seen: 5400, ip4: "198.51.100.7" },
  { id: 7, fqdn: "kiosk.example.net", engines: "claude", secure: false, seen: 7200, outdated: true, ip4: "203.0.113.21" },
  { id: 8, fqdn: "lab-01.example.net", engines: "codex,claude", secure: false, seen: 86400, claude: "2.1.170", ip4: "203.0.113.30" },
];

function hostRow(h: DemoHost) {
  const hasCodex = h.engines.includes("codex");
  const hasClaude = h.engines.includes("claude");
  return {
    id: h.id,
    fqdn: h.fqdn,
    status: h.seen < 3600 ? "online" : "active",
    last_refresh: ago(h.seen),
    claude_last_refresh: hasClaude ? ago(h.seen + 30) : null,
    updated_at: ago(h.seen),
    created_at: ago(86400 * 40 + h.id * 3600),
    client_version: hasCodex ? (h.codex ?? CODEX) : null,
    claude_client_version: hasClaude ? (h.claude ?? CLAUDE) : null,
    client_version_override: null,
    claude_client_version_override: null,
    wrapper_version: hasCodex ? WRAPPER : null,
    claude_wrapper_version: hasClaude ? WRAPPER : null,
    ip4: h.ip4,
    ip6: null,
    allow_roaming_ips: false,
    secure: h.secure ?? true,
    vip: h.vip ?? false,
    insecure_enabled_until: h.secure === false && h.id === 7 ? ahead(3600 * 5) : null,
    canonical_digest: hasCodex ? "5f2c9a1e7b3d4c60" : null,
    claude_canonical_digest: hasClaude ? "a81d0e44c2b9f713" : null,
    engines: h.engines,
    authed: true,
    auth_outdated: h.outdated ?? false,
    api_calls: 12842 - h.id * 1300,
  };
}

const SESSIONS = [
  {
    id: "11111111-1111-4111-8111-111111111111", engine: "claude", host: "atlas.example.net", host_id: 1,
    username: "ada", cwd: "/srv/checkout", presence: "working", started: 2400, turn: 75,
    work: { task: "Split the payment webhook handler into idempotent steps", branch: "feat/webhook-idempotency", target_branch: "main", address_alias: "brisk-heron" },
  },
  {
    id: "22222222-2222-4222-8222-222222222222", engine: "codex", host: "crane.example.net", host_id: 2,
    username: "ada", cwd: "/srv/checkout", presence: "working", started: 5100, turn: 210,
    work: { task: "Add contract tests for the refunds API", branch: "test/refund-contracts", target_branch: "main", address_alias: "quiet-lynx" },
  },
  {
    id: "33333333-3333-4333-8333-333333333333", engine: "codex", host: "forge.example.net", host_id: 3,
    username: "grace", cwd: "/srv/infra", presence: "listening", started: 9000, turn: null,
    attention: { since: ago(240), summary: "Waiting for your go-ahead on production." },
    work: { task: "Roll the Postgres 17 migration through staging", branch: "ops/pg17", target_branch: "main", address_alias: "amber-fox" },
  },
  {
    id: "44444444-4444-4444-8444-444444444444", engine: "claude", host: "harbor.example.net", host_id: 4,
    username: "grace", cwd: "/srv/docs", presence: "listening", started: 1300, turn: null,
    work: { task: "Review the refunds PR and leave notes on the board", branch: null, target_branch: null, address_alias: "calm-otter" },
  },
  {
    id: "55555555-5555-4555-8555-555555555555", engine: "claude", host: "build-02.example.net", host_id: 5,
    username: "ci", cwd: "/srv/checkout", presence: "working", started: 600, turn: 40, invocation: "exec",
    work: { task: "Nightly dependency audit", branch: "chore/deps-2026-09-23", target_branch: "main", address_alias: null },
  },
];

function session(s: (typeof SESSIONS)[number]) {
  return {
    id: s.id, engine: s.engine, host: s.host, host_id: s.host_id, username: s.username, cwd: s.cwd,
    invocation_kind: (s as { invocation?: string }).invocation ?? "interactive",
    upstream_session_id: null, status: "active", presence: s.presence, relay_ready: s.presence !== "working" || true,
    active_turn_id: s.turn ? `turn-${s.id.slice(0, 4)}` : null,
    active_turn_started_at: s.turn ? ago(s.turn) : null,
    started_at: ago(s.started), heartbeat_at: ago(5), last_event_at: ago(12),
    attention: (s as { attention?: unknown }).attention ?? null,
    ended_at: null, expires_at: null, close_requested_at: null, close: null, read_only: false,
    pending_prompt: s.id === FORGE_ID ? FORGE_PROMPT : null,
    work: {
      ...s.work,
      declared_paths: s.work.branch ? ["api/src/payments", "api/test"] : [],
      worktree_path: s.cwd,
      address: s.work.address_alias ? `zt-${s.id.slice(0, 6)}` : null,
    },
  };
}

/* ---------- agent timeline (console + portal) ---------- */

const FORGE_ID = "33333333-3333-4333-8333-333333333333";
const FORGE_QUESTION = "Staging passed all 212 checks. Apply the PG17 migration to production now, or wait for the 18:00 window?";
const FORGE_PROMPT = { id: "prompt-1", version: 1, created_at: ago(240), question: FORGE_QUESTION, options: ["Apply now", "Wait for 18:00", "Show me the diff first"] };

function timeline() {
  const ev = (cursor: number, type: string, source: string, payload: Record<string, unknown>, seconds: number) => ({
    cursor, session_id: FORGE_ID, type, source, payload, created_at: ago(seconds),
  });
  return [
    ev(1, "started", "engine", { summary: "Session started in /srv/infra" }, 9000),
    ev(2, "user_message", "portal", { text: "Roll PG17 through staging, then check with me before prod." }, 8900),
    ev(3, "progress", "engine", { summary: "Rebuilt pg_trgm, postgis and pgvector against PG17." }, 5400),
    ev(4, "assistant_message", "engine", { text: "Staging cut over in 41 s. Replication lag is back to 0 and the smoke suite is green." }, 600),
    ev(5, "waiting_input", "engine", { prompt_id: FORGE_PROMPT.id, prompt_version: 1, question: FORGE_QUESTION, options: FORGE_PROMPT.options }, 240),
  ];
}

/* ---------- memory atlas ---------- */

function memoryGraph() {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  const add = (n: Record<string, unknown>) => nodes.push(n);
  const link = (source: string, target: string, type: string) =>
    edges.push({ id: `${source}->${target}`, source, target, type });

  for (const scope of ["host", "project", "shared"]) add({ id: `scope:${scope}`, kind: "scope", label: scope });
  for (const h of HOSTS.slice(0, 5)) add({ id: `host:${h.id}`, kind: "host", label: h.fqdn, host_id: h.id });
  for (const p of ["checkout-v2", "infra-pg17"]) add({ id: `project:${p}`, kind: "project", label: p, project_slug: p });
  for (const t of ["deploy", "runbook", "postgres", "payments", "convention"]) add({ id: `tag:${t}`, kind: "tag", label: t });
  add({ id: "engine:codex", kind: "engine", label: "codex" });
  add({ id: "engine:claude", kind: "engine", label: "claude" });

  const memories: Array<[string, string, string, number | null, string | null, string[], string]> = [
    ["deploy.crane", "shared", "Deploy runbook: crane", 2, null, ["deploy", "runbook"], "codex"],
    ["conventions.git", "shared", "Branch and commit conventions", 1, null, ["convention"], "claude"],
    ["postgres.upgrades", "shared", "Postgres major upgrades", 3, null, ["postgres", "runbook"], "codex"],
    ["incident.2026-09-12", "shared", "Webhook retry storm post-mortem", 1, null, ["payments"], "claude"],
    ["api.contract", "project", "Refund API contract decisions", 2, "checkout-v2", ["payments"], "codex"],
    ["webhook.retries", "project", "Why webhooks retry 5x with jitter", 1, "checkout-v2", ["payments"], "claude"],
    ["release.freeze", "project", "Release freeze until 2026-09-30", 4, "checkout-v2", ["deploy"], "claude"],
    ["pg17.cutover", "project", "PG17 cutover checklist", 3, "infra-pg17", ["postgres", "deploy"], "codex"],
    ["pg17.extensions", "project", "Extensions to rebuild on PG17", 3, "infra-pg17", ["postgres"], "codex"],
    ["scratch.build-cache", "host", "Build cache lives on /srv/cache", 5, null, [], "claude"],
    ["scratch.node-version", "host", "Node 22 pinned via volta", 2, null, ["convention"], "codex"],
    ["scratch.ports", "host", "Local dev ports", 1, null, [], "claude"],
  ];
  memories.forEach(([key, scope, title, hostId, project, tags, engine], index) => {
    const id = `memory:${scope}:${key}`;
    add({
      id, node_id: id, memory_id: key, key, kind: "memory", label: title, record_id: index + 1, scope, title,
      summary: title, preview: title, tags, content_length: 400 + index * 90,
      host_id: scope === "host" ? hostId : null, host: scope === "host" ? HOSTS[(hostId ?? 1) - 1].fqdn : null,
      project_slug: project, source_host_id: hostId, source_host: HOSTS[(hostId ?? 1) - 1].fqdn,
      engine, revision: 1 + (index % 4), created_at: ago(86400 * (10 - (index % 9))), updated_at: ago(3600 * (index + 1)),
      capabilities: { read: true, create: true, update: true, delete: true, append: scope === "shared" },
    });
    link(id, `scope:${scope}`, "in_scope");
    if (scope === "host") link(id, `host:${hostId}`, "owned_by");
    else link(id, `host:${hostId}`, "written_by");
    if (project) link(id, `project:${project}`, "in_project");
    for (const t of tags) link(id, `tag:${t}`, "tagged_with");
    link(id, `engine:${engine}`, "from_engine");
  });

  const count = (values: string[]) =>
    [...new Set(values)].map((value) => ({ value, count: values.filter((v) => v === value).length }));
  return {
    status: "ok",
    nodes,
    edges,
    facets: {
      scopes: count(memories.map((m) => m[1])),
      hosts: HOSTS.slice(0, 5).map((h) => ({ id: h.id, label: h.fqdn, count: memories.filter((m) => m[3] === h.id).length })),
      projects: [
        { slug: "checkout-v2", label: "checkout-v2", count: 3 },
        { slug: "infra-pg17", label: "infra-pg17", count: 2 },
      ],
      tags: count(memories.flatMap((m) => m[5])),
      engines: count(memories.map((m) => m[6])),
    },
    facets_truncated: { hosts: false, projects: false, tags: false },
    totals: { all: 12, host: 3, project: 5, shared: 4 },
    count: 12,
    next_cursor: null,
    truncated: false,
  };
}

/* ---------- project board ---------- */

function card(id: number, title: string, column: { id: string; key: string; title: string }, extra: Record<string, unknown> = {}) {
  return {
    id: `card-${id}`, number: id, title, detail: "", labels: [], priority: 0, blocked_reason: null, column, claim: null,
    entered_column_at: ago(3600 * id), created_at: ago(86400 + id * 600), updated_at: ago(600 * id), ...extra,
  };
}

function claim(host: string, role: string, minutes: number) {
  return {
    held: true, role, username: "ada", host, worktree_path: "/srv/checkout",
    claimed_at: ago(minutes * 60), expires_at: ahead(1800), agent_address_bound: true, yours: false,
  };
}

function board() {
  const col = (id: string, key: string, title: string, position: number, cards: unknown[], extra: Record<string, unknown> = {}) => ({
    id, key, title, position, wip_limit: null, allowed_roles: null, default_next_column_id: null,
    is_intake: false, is_terminal: false, is_blocked: false, card_count: cards.length, over_wip: false, truncated: false, cards, ...extra,
  });
  const backlog = { id: "col-backlog", key: "backlog", title: "Backlog" };
  const coding = { id: "col-coding", key: "coding", title: "Coding" };
  const review = { id: "col-review", key: "review", title: "Review" };
  const done = { id: "col-done", key: "done", title: "Done" };
  return {
    project: "checkout-v2",
    board_slug: "default",
    latest_seq: 42,
    columns: [
      col("col-backlog", "backlog", "Backlog", 0, [
        card(48, "Expose refund status on the order page", backlog, { labels: ["frontend"] }),
        card(51, "Rate-limit webhook replays per merchant", backlog, { labels: ["payments"], priority: 1 }),
        card(53, "Document the idempotency key format", backlog, { labels: ["docs"] }),
      ], { is_intake: true }),
      col("col-coding", "coding", "Coding", 1, [
        card(42, "Split webhook handler into idempotent steps", coding, { labels: ["payments"], priority: 2, claim: claim("atlas.example.net", "code", 38) }),
        card(44, "Contract tests for the refunds API", coding, { labels: ["tests"], claim: claim("crane.example.net", "code", 85) }),
      ], { wip_limit: 3, allowed_roles: ["code"] }),
      col("col-review", "review", "Review", 2, [
        card(39, "Retry budget per merchant", review, { labels: ["payments"], claim: claim("harbor.example.net", "review", 12) }),
      ], { allowed_roles: ["review"] }),
      col("col-done", "done", "Done", 3, [
        card(31, "Move refunds to the outbox pattern", done, { labels: ["payments"] }),
        card(35, "Pin Node 22 in CI", done, { labels: ["infra"] }),
      ], { is_terminal: true }),
    ],
    your_claims: [],
    reclaimed_recently: [],
  };
}

/* ---------- git director ---------- */

function gitClones() {
  const wt = (id: string, user: string, engine: string, branch: string, task: string, paths: string[]) => ({
    worktree_id: id, worktree_path: id === "wt-4" ? "/srv/infra" : `/srv/checkout${id === "wt-1" ? "" : `-${id}`}`, username: user, engine, branch,
    head_sha: "8c7d0cc0a3cc", task, declared_paths: paths, target_branch: "main", agent_address_bound: true,
    heartbeat_at: ago(20), expires_at: ahead(1200),
  });
  const req = (id: string, worktree: string, verdict: string, by: string, reason: string, overlap: string[], minutes: number) => ({
    request_id: id, worktree_id: worktree, target_branch: "main", verdict, decided_by: by, reason, overlap,
    lease_expires_at: verdict === "allow" ? ahead(600) : null, requested_at: ago(minutes * 60), model: by === "llm" ? "claude-sonnet-5" : null,
    completed_at: verdict === "allow" ? null : ago(minutes * 60 - 5),
  });
  return {
    clones: [
      {
        clone_id: "clone-1", host_id: 1, fqdn: "atlas.example.net", repo_root: "/srv/checkout",
        remote_url: "git@git.example.net:shop/checkout.git", remote_key: "git.example.net/shop/checkout", last_seen_at: ago(20),
        worktrees: [
          wt("wt-1", "ada", "claude", "feat/webhook-idempotency", "Split the payment webhook handler into idempotent steps", ["api/src/payments/webhooks"]),
          wt("wt-2", "ada", "codex", "test/refund-contracts", "Add contract tests for the refunds API", ["api/test/contract", "api/src/payments/refunds"]),
          wt("wt-3", "ci", "claude", "chore/deps-2026-09-23", "Nightly dependency audit", ["package.json", "package-lock.json"]),
        ],
        leases: [req("req-7", "wt-1", "allow", "policy", "No overlap with open leases.", [], 3)],
        stale: [],
        recent: [
          req("req-8", "wt-2", "wait", "llm", "Both touch api/src/payments; let feat/webhook-idempotency land first.", ["api/src/payments/refunds/index.ts"], 1),
          req("req-7", "wt-1", "allow", "policy", "No overlap with open leases.", [], 3),
          req("req-6", "wt-3", "allow", "operator", "Approved from the console.", [], 55),
          req("req-5", "wt-2", "deny", "operator", "Rebase onto main first.", ["api/test/contract/refunds.test.ts"], 130),
        ],
      },
      {
        clone_id: "clone-2", host_id: 3, fqdn: "forge.example.net", repo_root: "/srv/infra",
        remote_url: "git@git.example.net:ops/infra.git", remote_key: "git.example.net/ops/infra", last_seen_at: ago(60),
        worktrees: [wt("wt-4", "grace", "codex", "ops/pg17", "Roll the Postgres 17 migration through staging", ["terraform/db", "ansible/postgres"])],
        leases: [],
        stale: [],
        recent: [req("req-4", "wt-4", "allow", "policy", "No overlap with open leases.", [], 400)],
      },
    ],
  };
}

/* ---------- fleet instructions ---------- */

const POLICY_DOC = `# Fleet Agent Policy

You are part of a fleet centrally managed by **Codex Orchestrator**.

## Hard Stop Lines

- Never push to \`main\` without a Git Director \`allow\`.
- Never print a credential you fetched with \`secret_get\`.

## Operating Contract

- **Execute-first.** Run the commands yourself, then prove it worked.
- **Smallest correct diff.** No drive-by refactors.
- **Behavior change means verify and document.**

## Memory

Call \`shared_memory_search\` before searching the filesystem.
Store the *why* — the code already records the what.
`;

const SECURITY_LEVELS = {
  autonomy: 3, git_history: 1, remote_hosts: 1, deploy_release: 1, destructive_data: 1,
  secrets_exposure: 1, security_controls: 1, dependencies: 1, verification_waiver: 0,
};

const BUILDER_STATE = {
  schema_version: 1, template_id: "fleet-standard", template_version: 1,
  enabled_modules: ["operating_contract", "security", "memory"], custom_instructions: "",
};

const BUILDER_CATALOG = {
  template_id: "fleet-standard",
  template_version: 1,
  required: [
    { id: "fleet_identity", label: "Fleet identity", description: "Managed by Codex Orchestrator.", required: true, default_enabled: true },
    { id: "safety_floor", label: "Precedence and safety floor", description: "Non-overridable boundaries.", required: true, default_enabled: true },
    { id: "hard_stops", label: "Hard Stop Lines", description: "Explicit stop conditions.", required: true, default_enabled: true },
  ],
  modules: [
    { id: "operating_contract", label: "Operating Contract", description: "Execute, then verify.", required: false, default_enabled: true },
    { id: "security", label: "Security and trust boundaries", description: "Protect secrets and checks.", required: false, default_enabled: true },
    { id: "memory", label: "Memory routing", description: "Where agents look things up.", required: false, default_enabled: true },
  ],
};

function agentVersions() {
  return [58, 57, 56, 55, 54].map((id, index) => ({
    id, sha256: `${id}c9a1e7b3d4c605f2c9a1e7b3d4c605f2c9a1e7b3d4c605f2c9a1e7b3d4c6`, size_bytes: 2400 - index * 40,
    created_at: ago(86400 * index + 3600), created_by: index % 2 ? "grace" : "ada", note: null,
  }));
}

/* ---------- router ---------- */

export function adminFixture(pathname: string, search: URLSearchParams): unknown {
  if (/^\/admin\/hosts\/\d+\/detail$/.test(pathname)) return undefined;
  switch (pathname) {
    case "/admin/auth/status":
      return { authenticated: true, enforced: true, user, roles: ["owner"], capabilities: [...CAPABILITIES] };
    case "/admin/setup/status":
      return setupStatus(true);
    case "/admin/ws/info":
      return { enabled: false };
    case "/admin/theme":
      return { theme: "auto" };
    case "/admin/overview":
      return {
        totals: { hosts: HOSTS.length },
        last_refresh: ago(40),
        versions: { cdx_version_available: CODEX, claude_version_available: CLAUDE, cdx_version_checked_at: ago(720), claude_version_checked_at: ago(720) },
        version_distribution: {
          codex: [{ version: CODEX, count: 5 }, { version: "0.156.0", count: 1 }],
          claude: [{ version: CLAUDE, count: 5 }, { version: "2.1.170", count: 1 }],
          install: { both: 4, codex_only: 2, claude_only: 2, neither: 0 },
        },
      };
    case "/admin/chatgpt/usage":
      return { snapshot: { plan_type: "pro", fetched_at: ago(180), primary_window: { used_percent: 61, limit_seconds: 604800, reset_after_seconds: 3600 * 61 }, secondary_window: { used_percent: 28, limit_seconds: 18000, reset_after_seconds: 9120 }, spark_window: { primary_window: { used_percent: 12, limit_seconds: 18000 } } } };
    case "/admin/claude/usage":
      return { snapshot: { source: "statusline", fetched_at: ago(240), five_hour_used_percent: 34, seven_day_used_percent: 47 } };
    case "/admin/chatgpt/usage/history":
    case "/admin/claude/usage/history": {
      const points = (offset: number) => Array.from({ length: 30 }, (_, i) => ({
        ts: new Date(NOW - (29 - i) * 86400000).toISOString(),
        value: 15 + Math.round(35 * Math.abs(Math.sin((i + offset) / 4))),
      }));
      const claude = pathname.startsWith("/admin/claude");
      return {
        days: Number(search.get("days") ?? 30), interval: "day", lane: "both", window: "both",
        series: claude
          ? [{ key: "five_hour", label: "5-hour window", points: points(2) }, { key: "seven_day", label: "Weekly window", points: points(5) }]
          : [
            { key: "normal_primary", label: "Weekly window", lane: "normal", window: "primary", limit_seconds: 604800, points: points(0) },
            { key: "normal_secondary", label: "5-hour window", lane: "normal", window: "secondary", limit_seconds: 18000, points: points(3) },
          ],
      };
    }
    case "/admin/runner":
      return { runner: { configured: true, ready: true, detail: "Both verification engines are ready.", engines: {
        codex: { state: "ok", last_check: ago(900), last_ok: ago(900), login_expiry: { state: "not_applicable", expires_at: null, days_remaining: null } },
        claude: { state: "ok", last_check: ago(900), last_ok: ago(900), login_expiry: { state: "ok", expires_at: ahead(86400 * 24), days_remaining: 24 } },
      } } };
    case "/admin/insecure-approvals/pending":
      return { requests: [] };
    case "/admin/hosts/insecure":
      return {
        count: 2, active: 1, domains: [], domains_active: 0, fleet_window: { open: false, until: null, opened_at: null },
        hosts: [
          { id: 7, fqdn: "kiosk.example.net", active: true, insecure_enabled_until: ahead(3600 * 5), secure: false },
          { id: 8, fqdn: "lab-01.example.net", active: false, insecure_enabled_until: null, secure: false },
        ],
      };
    case "/admin/hosts":
      return { hosts: HOSTS.map(hostRow) };
    case "/admin/agent-sessions":
      return { enabled: true, timings: { heartbeat_fresh_seconds: 45, relay_fresh_seconds: 60, retention_hours: 24 }, sessions: SESSIONS.map(session) };
    case `/admin/agent-sessions/${FORGE_ID}/events`:
      return { events: timeline(), next_cursor: 5 };
    case "/admin/memories/graph":
      return memoryGraph();
    case "/admin/projects/state":
      return { enabled: true };
    case "/admin/project-board/state":
      return { enabled: true, boards: 2, cards: 8, claimed: 3, updated_at: ago(300) };
    case "/admin/projects":
      return { projects: [
        { slug: "checkout-v2", title: "Checkout v2", description: "Refunds, webhooks, and the new order page", updated_at: ago(300), latest_seq: 42 },
        { slug: "infra-pg17", title: "Postgres 17", description: "Major upgrade across staging and prod", updated_at: ago(5400), latest_seq: 17 },
      ] };
    case "/admin/projects/checkout-v2":
      return { project: {
        slug: "checkout-v2", about: { title: "Checkout v2", name: "Payments", description: "Refunds, webhooks, and the new order page." },
        roster_markdown: "# Roster\n- @ada — owner\n- @grace — reviewer", latest_seq: 42, created_at: ago(86400 * 12), updated_at: ago(300),
        counts: { notes: 4, open_todos: 3, done_todos: 9, files: 2, feedback: 1 },
      }, notes: [], todos: [], files: [], feedback: [], recent_changes: [] };
    case "/admin/projects/checkout-v2/summary":
      return { project: {
        slug: "checkout-v2", about: { title: "Checkout v2", name: "Payments", description: "Refunds, webhooks, and the new order page." },
        roster_markdown: "# Roster\n- @ada — owner", latest_seq: 42, created_at: ago(86400 * 12), updated_at: ago(300),
        counts: { notes: 4, open_todos: 3, done_todos: 9, files: 2, feedback: 1 }, feedback_by_type: { bug: 1, status_open: 1 },
      } };
    case "/admin/projects/checkout-v2/board":
      return board();
    case "/admin/git-director/state":
      return { enabled: true, model: "claude-sonnet-5", clones: 2, worktrees: 4, updated_at: ago(20) };
    case "/admin/git-director":
      return gitClones();
    case "/admin/openai/keys":
      return [
        { id: 1, name: "IDE plugin (Ada)", key_prefix: "sk-coco-7Hq2", is_active: true, use_count: 1842, last_used_at: ago(300), expires_at: ahead(86400 * 60), created_at: ago(86400 * 30) },
        { id: 2, name: "Docs search bot", key_prefix: "sk-coco-Lm9x", is_active: true, use_count: 311, last_used_at: ago(7200), expires_at: ahead(86400 * 14), created_at: ago(86400 * 9) },
        { id: 3, name: "Old CI runner", key_prefix: "sk-coco-a01Z", is_active: false, use_count: 97, last_used_at: ago(86400 * 21), expires_at: null, created_at: ago(86400 * 80) },
      ];
    case "/admin/claude/keys":
      return [
        { id: 4, name: "Review bot", key_prefix: "sk-coco-Qe4r", is_active: true, use_count: 624, last_used_at: ago(900), expires_at: ahead(86400 * 45), created_at: ago(86400 * 20) },
      ];
    case "/admin/claude/settings":
      return { default_model: "claude-sonnet-5", max_tokens: 8192, disabled: false };
    case "/admin/api/state":
      return { disabled: false, api_disabled: false };
    case "/admin/openai/state":
    case "/admin/claude/state":
      return { disabled: false, api_disabled: false };
    case "/admin/agents":
      return {
        status: "ok", mode: "latest", active_id: 58, served_id: 58, latest_id: 58, backup_limit: 20,
        sha256: "58c9a1e7b3d4c605f2c9a1e7b3d4c605f2c9a1e7b3d4c605f2c9a1e7b3d4c6", updated_at: ago(3600), size_bytes: POLICY_DOC.length,
        content: POLICY_DOC, generation_mode: "managed", builder_state: BUILDER_STATE, builder_catalog: BUILDER_CATALOG, versions: agentVersions(),
      };
    case "/admin/agents-generation-mode":
      return { status: "ok", mode: "managed", modes: ["managed", "manual", "off"] };
    case "/admin/agents/compose":
      return { composition: BUILDER_STATE, content: POLICY_DOC, sha256: "58c9a1e7", size_bytes: POLICY_DOC.length };
    case "/admin/agents/render":
      return { status: "ok", host_id: 1, host_fqdn: "atlas.example.net", engine: "claude", version_id: 58, sha256: "a81d0e44c2b9f713", size_bytes: POLICY_DOC.length, content: POLICY_DOC,
        sections: { skills: { present: true, reason: "included", count: 9 }, memory: { present: true, reason: "included" } } };
    case "/admin/agent-policy-profiles":
      return { profiles: [
        { id: 1, name: "fleet-default", description: "Today's fleet policy.", levels: SECURITY_LEVELS, is_default: true, revision: 3, created_at: ago(86400 * 30), updated_at: ago(86400 * 2), host_ids: [] },
        { id: 2, name: "contained", description: "Kiosks and lab machines.", levels: { ...SECURITY_LEVELS, autonomy: 1 }, is_default: false, revision: 1, created_at: ago(86400 * 10), updated_at: ago(86400 * 10), host_ids: [7, 8] },
      ], catalog: { axes: [], presets: [], bands: ["Refuse", "Ask", "On request", "Announce", "Proceed"], default_levels: SECURITY_LEVELS } };
    case "/admin/skills":
      return { skills: [
        { slug: "coco", display_name: "CoCo", description: "Project coordination", status: "ok" },
        { slug: "deploy-verify", display_name: "Deploy verify", description: "Post-deploy checks", status: "ok" },
      ] };
    case "/admin/model-defaults/codex":
      return { engine: "codex", model: "gpt-5.6-sol", reasoning_effort: "high", catalog: [{ model: "gpt-5.6-sol", persistent_efforts: ["medium", "high"], default_effort: "high" }] };
    case "/admin/model-defaults/claude":
      return { engine: "claude", model: "claude-opus-5-5", reasoning_effort: "high", catalog: [{ model: "claude-opus-5-5", persistent_efforts: ["medium", "high"], default_effort: "high" }] };
    case "/admin/versions/check":
      return {
        available_client: { version: CODEX, updated_at: ago(720), source: "github" },
        versions: { client_version: CODEX, client_version_enforce_exact: false, reported_client_version: CODEX },
        claude_available_client: { version: CLAUDE },
        claude_versions: { client_version: CLAUDE, client_version_enforce_exact: false, reported_client_version: CLAUDE },
      };
    case "/admin/users":
      return { users: [] };
    default:
      return undefined;
  }
}

/** The first-run wizard, mid-way: infrastructure green, owner claimed. */
export function setupStatus(done: boolean) {
  const checks = [
    ["database", "Database reachable", "MySQL 8.4 answered in 3 ms."],
    ["migrations", "Schema migrated", "All 64 migrations applied."],
    ["encryption_key", "Encryption key present", "AUTH_ENCRYPTION_KEY loaded (kid 2)."],
    ["public_base_url", "Public URL configured", "https://orchestrator.example.net"],
    ["wrapper_artifacts", "Wrapper artifacts published", `cxx ${WRAPPER} for 4 platforms.`],
    ["runner", "Verification runner reachable", "Both engines ready."],
  ].map(([id, label, detail]) => ({ id, label, ok: true, critical: true, detail }));
  return {
    critical_complete: true, owner_created: true, setup_complete: true, checks,
    configured_engines: done ? ["codex", "claude"] : [],
    canonical_auth: { codex: done, claude: done },
    hosts: { total: done ? HOSTS.length : 0, synced: done ? 6 : 0 },
    public_base_url: "https://orchestrator.example.net",
    warnings: [],
    next_actions: [],
    wizard: done
      ? { completed_at: ago(86400 * 40), dismissed_at: null, last_step: "first_host", engines: ["codex", "claude"] }
      : { completed_at: null, dismissed_at: null, last_step: "engines", engines: ["codex", "claude"] },
  };
}

/* ---------- agent portal (/go) ---------- */

export function portalFixture(pathname: string): unknown {
  const forge = session(SESSIONS[2]);
  const agent = { ...forge, attention: { since: ago(240), summary: "Waiting for your go-ahead on production." } };
  if (pathname.endsWith("/api/state")) return { status: "ok", data: { enabled: true, timings: { heartbeat_fresh_seconds: 45, relay_fresh_seconds: 60, retention_hours: 24 } } };
  if (pathname.endsWith("/api/me")) return { status: "ok", data: { user: { id: 1, display_name: "Grace" } } };
  if (pathname.endsWith("/api/agents")) return { status: "ok", data: { agents: [agent], generated_at: new Date(NOW).toISOString() } };
  if (pathname.includes("/events")) return { status: "ok", data: { events: timeline(), next_cursor: 5 } };
  return { status: "ok", data: {} };
}
