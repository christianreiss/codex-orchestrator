import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { CAPABILITIES } from "../src/lib/auth/capabilities";
export const user = {
  id: 1,
  username: "operator",
  name: "Console Operator",
  access_level: "owner",
  roles: ["owner"],
};

export const RENDERED_AGENTS_CONTENT =
  "# Fleet policy\n\nRendered for `console.example.test`.\n\n- Preserve unrelated changes.\n" +
  "- Keep every rendered rule readable.\n".repeat(32);

export const BUILDER_STATE = {
  schema_version: 1,
  template_id: "fleet-standard",
  template_version: 1,
  enabled_modules: ["operating_contract", "security", "midnight_rule"],
  custom_instructions: "",
};

export const SECURITY_LEVELS_STANDARD = {
  autonomy: 3,
  git_history: 1,
  remote_hosts: 1,
  deploy_release: 1,
  destructive_data: 1,
  secrets_exposure: 1,
  security_controls: 1,
  dependencies: 1,
  verification_waiver: 0,
};

export const SECURITY_CATALOG = {
  axes: [
    {
      id: "autonomy",
      label: "Working without asking",
      description: "How much the agent proceeds on its own.",
      enforcement: "mechanical",
      bands: ["Confirm every step", "Ask whenever unsure", "Ask only at a Hard Stop", "State the assumption and proceed", "No check-ins"],
    },
    {
      id: "verification_waiver",
      label: "Skipping verification",
      description: "How much verification may be skipped.",
      enforcement: "prose_only",
      bands: ["Never skip", "Skip only unrelated checks", "Skip when told", "Skip by default", "Skip freely"],
    },
  ],
  presets: [
    { id: "contained", label: "Contained", description: "Refuses every privileged action.", levels: { ...SECURITY_LEVELS_STANDARD, autonomy: 0 } },
    { id: "standard", label: "Standard", description: "Today's fleet policy.", levels: SECURITY_LEVELS_STANDARD },
  ],
  bands: ["Refuse", "Ask", "On request", "Announce", "Proceed"],
  default_levels: SECURITY_LEVELS_STANDARD,
};

/**
 * A rendered document with real `##` sections, for the provenance tests. The
 * default render fixture deliberately keeps its heading-free content, because
 * the copy-exactness test compares the clipboard against it byte for byte.
 */
export const PROVENANCE_DOC = [
  "# Fleet Agent Policy",
  "",
  "## Hard Stop Lines",
  "",
  "Stop and ask only when at least one applies.",
  "",
  "## Operating Contract (FAST)",
  "",
  "Execute and verify.",
  "",
  "## Security and Trust Boundaries",
  "",
  "Never commit secrets.",
  "",
].join("\n");

export const PROVENANCE_ENTRIES = [
  { key: "policy:hard_stops", label: "Hard Stop Lines", group: "policy", headings: ["Hard Stop Lines"] },
  {
    key: "module:operating_contract",
    label: "Operating Contract",
    group: "module",
    headings: ["Operating Contract (FAST)"],
  },
  {
    key: "module:security",
    label: "Security and trust boundaries",
    group: "module",
    headings: ["Security and Trust Boundaries"],
  },
];

export const BUILDER_CATALOG = {
  template_id: "fleet-standard",
  template_version: 1,
  required: [
    { id: "fleet_identity", label: "Fleet identity", description: "Managed by Codex Orchestrator.", required: true, default_enabled: true },
    { id: "safety_floor", label: "Precedence and safety floor", description: "Non-overridable boundaries.", required: true, default_enabled: true },
    { id: "hard_stops", label: "Hard Stop Lines", description: "Explicit stop conditions.", required: true, default_enabled: true },
  ],
  modules: [
    { id: "operating_contract", label: "Operating Contract", description: "Execute and verify.", required: false, default_enabled: true },
    { id: "security", label: "Security and trust boundaries", description: "Protect secrets and checks.", required: false, default_enabled: true },
    { id: "midnight_rule", label: "Midnight Rule", description: "Keep late-night scope small.", required: false, default_enabled: true },
  ],
};

/**
 * Every direct destination from the shared route registry. Keep this explicit
 * rather than importing the registry into Playwright: a stale test should
 * fail when a route is renamed without its browser contract being reviewed.
 */
export const CANONICAL_DESTINATIONS = [
  { path: "/dashboard", heading: "Overview", title: "Overview" },
  { path: "/accounts", heading: "Accounts", title: "Accounts" },
  { path: "/agents", heading: "Agents", title: "Agents" },
  { path: "/activity", heading: "Activity", title: "Activity" },
  { path: "/reports", heading: "Reports", title: "Reports" },
  { path: "/hosts", heading: "Hosts", title: "Hosts" },
  { path: "/engines", heading: "Engines", title: "Engines" },
  { path: "/settings", heading: "Settings", title: "Settings" },
  { path: "/projects", heading: "Projects", title: "Projects" },
  { path: "/agent-messaging", heading: "Messages", title: "Messages" },
  { path: "/schedules", heading: "Timed wake-ups", title: "Timed wake-ups" },
  { path: "/git-director", heading: "Git merges", title: "Git merges" },
  { path: "/transfers", heading: "Shared files", title: "Shared files" },
  { path: "/library", heading: "Library", title: "Library" },
  { path: "/library?type=memories", heading: "Library", title: "Library" },
  { path: "/library?type=subagents", heading: "Library", title: "Library" },
  { path: "/library/agent-rules", heading: "Agent rules", title: "Agent rules" },
  { path: "/people", heading: "People", title: "People" },
  { path: "/api-keys", heading: "API keys", title: "API keys" },
  { path: "/secrets", heading: "Secrets", title: "Secrets" },
  { path: "/manual", heading: "Manual", title: "Manual" },
  { path: "/account", heading: "Account", title: "Account" },
] as const;

export function fixture(pathname: string): Record<string, unknown> {
  if (pathname === "/admin/manual/manifest") return JSON.parse(readFileSync("../public/admin/manual/manifest.json", "utf8"));
  if (pathname.startsWith("/admin/manual/article/")) {
    const slug = pathname.split("/").at(-1)!;
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("Invalid manual fixture slug");
    const source = readFileSync(`../public/admin/manual/articles/${slug}.md`, "utf8");
    return { slug, meta: {}, body: source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") };
  }
  switch (pathname) {
    case "/admin/api/state": return { disabled: false };
    case "/admin/claude/settings": return { default_model: "claude-sonnet-5", max_tokens: 8192 };
    case "/admin/api/surfaces": return {
      surfaces: [
        { surface: "openai", label: "OpenAI-compatible", base_path: "/v1", wire: "openai", backend: "codex", identity_backend: "codex", disabled: false, key_count: 0 },
        { surface: "anthropic", label: "Anthropic-compatible", base_path: "/anthropic/v1", wire: "anthropic", backend: "claude", identity_backend: "claude", disabled: false, key_count: 0 },
        { surface: "grok", label: "Grok (OpenAI-compatible)", base_path: "/grok/v1", wire: "openai", backend: "grok", identity_backend: "grok", disabled: false, key_count: 0 },
      ],
      backends: [{ engine: "codex", label: "Codex" }, { engine: "claude", label: "Claude" }, { engine: "grok", label: "Grok" }],
    };
    case "/admin/auth/status":
      return { authenticated: true, enforced: true, user, roles: ["owner"], capabilities: [...CAPABILITIES] };
    case "/admin/setup/status":
      return { setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: "2026-09-28T00:00:00Z", dismissed_at: null } };
    case "/admin/ws/info":
      return { enabled: false };
    case "/admin/topology":
      return {
        generated_at: "2026-08-27T09:00:00Z",
        server: { id: "server", label: "orchestrator.example", started_at: "2026-08-26T09:00:00Z", uptime_s: 86_400, communicator_enabled: true, portal_enabled: true, scope: "api_process" },
        communicators: [],
        agents: [],
        recent_disconnects: [],
        counts: { communicators: 0, agents: 0, attributed: 0, stale: 0, unattributed: 0 },
      };
    case "/admin/agent-sessions":
      // One working agent, so the page renders its grouped list rather than
      // either empty state. `enabled` is what separates "nobody is running"
      // from "the module is off"; both are real and only one is a problem.
      return {
        enabled: true,
        timings: { heartbeat_fresh_seconds: 45, relay_fresh_seconds: 60, retention_hours: 24 },
        sessions: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            engine: "claude",
            host: "biest.example",
            host_id: 1,
            username: "chris",
            cwd: "/srv/repo/api",
            invocation_kind: "interactive",
            upstream_session_id: null,
            status: "active",
            presence: "working",
            relay_ready: true,
            active_turn_id: "turn-1",
            active_turn_started_at: new Date(Date.now() - 60_000).toISOString(),
            started_at: new Date(Date.now() - 600_000).toISOString(),
            heartbeat_at: new Date().toISOString(),
            last_event_at: new Date().toISOString(),
            attention: null,
            ended_at: null,
            expires_at: null,
            close_requested_at: null,
            close: null,
            read_only: false,
            pending_prompt: null,
            work: {
              task: "Mirror the portal read surface into the console",
              branch: "feat/console-agent-sessions",
              target_branch: "main",
              declared_paths: ["api/src"],
              worktree_path: "/srv/repo",
              address: "zt-demo",
              address_alias: "crisp-otter",
            },
          },
        ],
      };
    case "/admin/accounts": return { accounts: [] };
    case "/admin/chatty/status": return { visible: false, ready: false, enabled: false, knowledge_version: "test", engines: [] };
    case "/admin/chatty/settings": return { enabled: false, engine_order: ["codex", "claude", "grok"], concurrency: 1, queue_limit: 10, steps: 10, timeout_seconds: 120 };
    case "/admin/authorization": return { mode: "compatible", updated_at: null, would_deny: [] };
    case "/admin/watchdogs": return { watchdogs: [] };
    case "/admin/schedules": return { schedules: [], next_cursor: null };
    case "/admin/git-director/state": return { enabled: true, model: "test", clones: 0, worktrees: 0, updated_at: null };
    case "/admin/git-director": return { clones: [] };
    case "/admin/git-director/commit-settings": return { message_style: "short", ai_attribution: true };
    case "/admin/transfers/state": return { enabled: true, updated_at: null, used_bytes: 0, live_count: 0, default_ttl_seconds: 3600, max_ttl_seconds: 86400, max_file_bytes: 1048576, quota_bytes: 10485760 };
    case "/admin/transfers": return { transfers: [] };
    case "/admin/theme":
      return { theme: "auto" };
    case "/admin/openai/keys":
    case "/admin/claude/keys":
      return [];
    case "/admin/passkeys":
      return {
        passkeys: [
          {
            id: 1,
            name: "Operator laptop",
            created_at: "2026-07-30T08:00:00Z",
            last_used_at: "2026-08-01T08:00:00Z",
          },
          {
            id: 2,
            name: "Hardware key",
            created_at: "2026-07-15T08:00:00Z",
            last_used_at: null,
          },
        ],
      };
    case "/admin/claude/config":
      return {
        status: "ok",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        updated_at: "2026-08-01T08:00:00Z",
        settings: {
          env: { OPERATIONS_MODE: "managed" },
          permissions: { allow: ["Bash(npm run *)"], ask: ["Bash(git push *)"] },
          permissionMode: "default",
          statusLine: { type: "command", command: "~/.claude/statusline.sh" },
          hooks: { SessionStart: [{ matcher: "*", commands: ["~/bin/session-start"] }] },
          advisorModel: "claude-opus-4-1",
        },
      };
    // Fleet engine master switches. The path-keyed POST cannot see its body,
    // so it answers as a disable; tests that need the other edge override it.
    case "/admin/engines/state":
      return {
        engines: (["codex", "claude", "grok"] as const).map((engine) => ({
          engine,
          label: engine === "codex" ? "Codex" : engine === "claude" ? "Claude" : "Grok",
          enabled: true,
          updated_at: null,
          updated_by: null,
          assigned_hosts: engine === "codex" ? 2 : 1,
        })),
      };
    case "/admin/engines/codex/state":
    case "/admin/engines/claude/state":
    case "/admin/engines/grok/state": {
      const engine = pathname.split("/")[3]!;
      return {
        engine,
        label: engine === "codex" ? "Codex" : engine === "claude" ? "Claude" : "Grok",
        enabled: false,
        updated_at: "2026-10-03T08:00:00Z",
        updated_by: "chris",
        assigned_hosts: 1,
        previous: true,
        hosts_suspended: 1,
      };
    }
    case "/admin/grok/state": return { disabled: false };
    case "/admin/grok/settings": return { default_model: "grok-4.6", disabled: false };
    case "/admin/grok/keys": return [];
    case "/admin/grok/models": return { models: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"].map(id => ({ id, enabled: true, ownedBy: "xai" })) };
    case "/admin/model-defaults/grok": return {
      engine: "grok", model: "grok-4.6", reasoning_effort: "high", context_window: 256_000,
      catalog: [
        { model: "grok-4.6", persistent_efforts: ["low", "medium", "high", "xhigh"], default_effort: "high", context_windows: [256_000, 500_000], default_context_window: 256_000 },
        { model: "grok-4.5", persistent_efforts: ["low", "medium", "high"], default_effort: "high", context_windows: [256_000, 500_000], default_context_window: 256_000 },
      ],
    };
    case "/admin/model-defaults/codex":
      return {
        engine: "codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        catalog: [{ model: "gpt-5.6-sol", persistent_efforts: ["medium", "high"], default_effort: "high" }],
      };
    case "/admin/model-defaults/claude":
      return {
        engine: "claude",
        model: "claude-opus-4-1",
        reasoning_effort: "high",
        catalog: [{ model: "claude-opus-4-1", persistent_efforts: ["medium", "high"], default_effort: "high" }],
      };
    case "/admin/versions/check":
      return {
        available_client: { version: "0.125.0", updated_at: "2026-08-01T08:00:00Z", source: "github" },
        versions: {
          client_version: "0.125.0",
          client_version_enforce_exact: false,
          reported_client_version: "0.125.0",
        },
        grok_available_client: { version: "1.0.46" },
        grok_versions: { client_version: "1.0.46", client_version_enforce_exact: true, reported_client_version: "1.0.46" },
        claude_available_client: { version: "2.1.170" },
        claude_versions: {
          client_version: "2.1.170",
          client_version_enforce_exact: false,
          reported_client_version: "2.1.170",
        },
      };
    case "/admin/quota-mode":
      return { hard_fail: true, limit_percent: 95, week_partition: 7 };
    case "/admin/scaling":
      return {
        enabled: true,
        rules: {
          enabled: true,
          tiers: [
            {
              at_percent: 75,
              lane: "spark",
              reasoning_effort: "high",
              model: "gpt-5.6-sol",
            },
          ],
        },
        active_tier: {
          at_percent: 75,
          lane: "spark",
          reasoning_effort: "high",
          model: "gpt-5.6-sol",
        },
      };
    case "/admin/overview":
      return {
        totals: { hosts: 2 },
        last_refresh: "2026-08-01T08:00:00Z",
        versions: { client_version: "latest", cdx_version_available: "1.0.0", claude_version_available: "2.0.0" },
        version_distribution: { codex: [{ version: "0.125.0", count: 2 }], claude: [], install: { both: 1, codex_only: 1, claude_only: 0, neither: 0 } },
      };
    case "/admin/insecure-approvals/pending":
      return { requests: [] };
    case "/admin/projects/state":
      return { enabled: true };
    case "/admin/project-board/state":
      return { enabled: false, boards: 7, cards: 6, claimed: 1, updated_at: "2026-08-27T09:00:00Z" };
    case "/admin/projects":
      return {
        projects: [{ slug: "fleet-console", title: "Fleet console", description: "Admin redesign", updated_at: "2026-08-01T08:00:00Z", latest_seq: 4 }],
      };
    case "/admin/projects/fleet-console":
    case "/admin/projects/fleet-console/summary":
      return {
        project: {
          slug: "fleet-console",
          about: {
            title: "Fleet console",
            name: "Operations",
            description: "A shared workspace for fleet coordination.",
          },
          roster_markdown: "# Roster\n- @operator — owner",
          latest_seq: 4,
          created_at: "2026-08-01T08:00:00Z",
          updated_at: "2026-08-01T08:00:00Z",
          counts: { notes: 2, open_todos: 1, done_todos: 1, files: 3, feedback: 1 },
        },
        notes: [],
        todos: [],
        files: [],
        feedback: [{ id: 1, type: "bug", title: "Sample", body: "Sample feedback" }],
        recent_changes: [],
      };
    case "/admin/projects/fleet-console/todos":
      return {
        project: "fleet-console",
        todos: [
          {
            id: 1,
            title: "Refresh runner image",
            detail: "Verify the new image on a staging host.",
            done: false,
            created_at: "2026-08-01T08:00:00Z",
            updated_at: "2026-08-01T08:00:00Z",
          },
          {
            id: 2,
            title: "Capture baseline",
            detail: "",
            done: true,
            created_at: "2026-08-01T08:00:00Z",
            updated_at: "2026-08-01T08:00:00Z",
          },
        ],
      };
    case "/admin/projects/fleet-console/board":
      return {
        project: "fleet-console",
        board_slug: "default",
        latest_seq: 4,
        columns: [
          {
            id: "col-backlog",
            key: "backlog",
            title: "Backlog",
            position: 0,
            wip_limit: null,
            allowed_roles: null,
            default_next_column_id: "col-coding",
            is_intake: true,
            is_terminal: false,
            is_blocked: false,
            card_count: 1,
            over_wip: false,
            truncated: false,
            cards: [
              {
                id: "card-1",
                number: 1,
                title: "Refresh runner image",
                detail: "Verify the new image on a staging host.",
                labels: [],
                priority: 0,
                blocked_reason: null,
                column: { id: "col-backlog", key: "backlog", title: "Backlog" },
                claim: null,
                entered_column_at: "2026-08-01T08:00:00Z",
                created_at: "2026-08-01T08:00:00Z",
                updated_at: "2026-08-01T08:00:00Z",
              },
            ],
          },
          {
            id: "col-coding",
            key: "coding",
            title: "Coding",
            position: 1,
            wip_limit: 1,
            allowed_roles: ["code"],
            default_next_column_id: null,
            is_intake: false,
            is_terminal: false,
            is_blocked: false,
            card_count: 2,
            over_wip: true,
            truncated: false,
            cards: [
              {
                id: "card-2",
                number: 2,
                title: "Capture baseline",
                detail: "",
                labels: ["infra"],
                priority: 0,
                blocked_reason: null,
                column: { id: "col-coding", key: "coding", title: "Coding" },
                // A held card, so the claim badge and the holder line are
                // exercised rather than only the empty state.
                claim: {
                  held: true,
                  role: "code",
                  username: "chris",
                  host: "crane.example",
                  worktree_path: "/srv/fleet-console",
                  claimed_at: "2026-08-01T08:00:00Z",
                  expires_at: "2099-01-01T00:00:00Z",
                  agent_address_bound: true,
                  yours: false,
                },
                entered_column_at: "2026-08-01T08:00:00Z",
                created_at: "2026-08-01T08:00:00Z",
                updated_at: "2026-08-01T08:00:00Z",
              },
            ],
          },
        ],
        your_claims: [],
        reclaimed_recently: [
          {
            id: "card-9",
            number: 9,
            title: "Rotate the signer",
            released_at: "2026-08-01T09:00:00Z",
            reason: "Claim reclaimed: the holding agent is no longer running.",
          },
        ],
      };
    case "/admin/projects/fleet-console/notes":
      return {
        project: "fleet-console",
        notes: [
          {
            id: 3,
            header: "Rollout note",
            body: "Review the runner result before widening the rollout.",
            created_at: "2026-08-01T08:00:00Z",
            updated_at: "2026-08-01T08:00:00Z",
          },
        ],
      };
    case "/admin/projects/fleet-console/files":
      return {
        project: "fleet-console",
        files: [
          {
            id: 4,
            stored_name: "docs/rollout.md",
            description: "Deployment checklist",
            content_sha256: "abcdef",
            mime_type: "text/markdown",
            size_bytes: 64,
            content: "# Rollout",
            created_at: "2026-08-01T08:00:00Z",
            updated_at: "2026-08-01T08:00:00Z",
          },
        ],
      };
    case "/admin/projects/fleet-console/feedback":
      return {
        project: "fleet-console",
        feedback: [
          {
            id: 5,
            type: "bug",
            title: "Runner label is stale",
            body: "Surface the last successful check timestamp.",
            created_at: "2026-08-01T08:00:00Z",
            updated_at: "2026-08-01T08:00:00Z",
          },
        ],
      };
    case "/admin/projects/fleet-console/changes":
      return {
        project: "fleet-console",
        since: 0,
        latest_seq: 7,
        changes: [
          {
            seq: 7,
            eventType: "todo",
            action: "updated",
            entityType: "todo",
            entityId: 1,
            payloadJson: { done: false },
            sourceHostId: 1,
            createdAt: "2026-08-01T08:00:00Z",
          },
        ],
      };
    case "/admin/skills":
      return { skills: [{ slug: "fleet-ops", display_name: "Fleet operations", description: "Operator runbook", status: "ok" }] };
    case "/admin/host-daemons":
      return { hosts: [] };
    case "/admin/hosts":
      return {
        hosts: [
          {
            id: 1,
            fqdn: "console.example.test",
            status: "online",
            last_refresh: "2026-08-01T08:00:00Z",
            claude_last_refresh: "2026-08-01T08:00:00Z",
            updated_at: "2026-08-01T08:00:00Z",
            created_at: "2026-07-01T08:00:00Z",
            client_version: "0.125.0",
            claude_client_version: "2.1.170",
            client_version_override: null,
            claude_client_version_override: null,
            wrapper_version: "2.4.0",
            claude_wrapper_version: "2.4.0",
            ip4: "192.0.2.20",
            ip6: null,
            allow_roaming_ips: false,
            secure: true,
            vip: false,
            insecure_enabled_until: null,
            canonical_digest: "0123456789abcdef",
            claude_canonical_digest: "abcdef0123456789",
            engines: "codex,claude",
            engine_readiness: {
              codex: { state: "ready", reasons: [], cli_version: "0.125.0", cli_target: "0.125.0", wrapper_version: "2.4.0", wrapper_target: "2.4.0" },
              claude: { state: "ready", reasons: [], cli_version: "2.1.170", cli_target: "2.1.170", wrapper_version: "2.4.0", wrapper_target: "2.4.0" },
            },
            authed: true,
            auth_outdated: false,
          },
        ],
      };
    case "/admin/agent-policy-profiles":
      return {
        profiles: [
          {
            id: 1,
            name: "fleet-default",
            description: "Today's fleet policy.",
            levels: SECURITY_LEVELS_STANDARD,
            is_default: true,
            revision: 1,
            created_at: "2026-08-02T08:00:00Z",
            updated_at: "2026-08-02T08:00:00Z",
            host_ids: [],
          },
        ],
        catalog: SECURITY_CATALOG,
      };
    case "/admin/agents":
      return {
        status: "ok",
        mode: "latest",
        active_id: 55,
        served_id: 55,
        latest_id: 55,
        backup_limit: 20,
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        updated_at: "2026-08-02T08:00:00Z",
        size_bytes: 84,
        content: "## Operating Contract (FAST)\n\nExecute and verify.\n",
        generation_mode: "managed",
        builder_state: BUILDER_STATE,
        builder_catalog: BUILDER_CATALOG,
        versions: [],
      };
    case "/admin/agents-generation-mode":
      return { status: "ok", mode: "managed", modes: ["managed", "manual", "off"] };
    case "/admin/agents/compose":
      return {
        composition: BUILDER_STATE,
        content: "## Operating Contract (FAST)\n\nExecute and verify.\n",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        size_bytes: 56,
      };
    case "/admin/agents/render":
      return {
        status: "ok",
        host_id: 1,
        host_fqdn: "console.example.test",
        engine: "codex",
        version_id: 55,
        sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        size_bytes: RENDERED_AGENTS_CONTENT.length,
        content: RENDERED_AGENTS_CONTENT,
        sections: {
          skills: { present: true, reason: "included", count: 4 },
          memory: { present: true, reason: "included" },
        },
      };
    case "/admin/hosts/1/detail":
      return {
        host: {
          id: 1,
          fqdn: "console.example.test",
          status: "online",
          last_refresh: "2026-08-01T08:00:00Z",
          claude_last_refresh: "2026-08-01T08:00:00Z",
          updated_at: "2026-08-01T08:00:00Z",
          created_at: "2026-07-01T08:00:00Z",
          client_version: "1.0.0",
          claude_client_version: "2.0.0",
          client_version_override: null,
          claude_client_version_override: null,
          agents_document_id_override: null,
          wrapper_version: "2.4.0",
          claude_wrapper_version: "2.4.0",
          api_calls: 48,
          ip4: "192.0.2.20",
          ip6: null,
          allow_roaming_ips: false,
          secure: true,
          vip: false,
          insecure_enabled_until: null,
          insecure_grace_until: null,
          insecure_window_minutes: 10,
          curl_insecure: false,
          browseros_mcp_enabled: true,
          last_cron_check: "2026-08-01T08:00:00Z",
          reverse_dns_mode: null,
          lane_preference: "normal",
          model_override: null,
          reasoning_effort_override: null,
          claude_model_override: null,
          claude_reasoning_effort_override: null,
          engines: "codex,claude",
          engines_list: ["codex", "claude"],
          auto_update_override: null,
          effective_auto_update_enabled: true,
          auto_update_state: "current",
          auto_update_label: "Current",
          auto_update_emoji: null,
          auto_update_rank: 0,
          auto_update_last_event_at: null,
          auto_update_target_version: null,
          canonical_digest: "0123456789abcdef0123456789abcdef",
          claude_canonical_digest: "abcdef0123456789abcdef0123456789",
          recent_digests: [],
          claude_recent_digests: [],
          authed: true,
          auth_outdated: false,
          auth_source: true,
          users: [],
        },
        overview: {
          versions: {
            client_version: "1.0.0",
            wrapper_version: "2.4.0",
            client_version_checked_at: "2026-08-01T08:00:00Z",
            claude_version: "2.0.0",
          },
          reverse_dns_enabled: true,
          auto_update_enabled: true,
          inactivity_window_days: 30,
        },
      };
    case "/admin/users":
      return { users: [] };
    case "/admin/agent-messaging/state":
      return {
        enabled: true,
        initial_default: false,
        addresses: 2,
        live_addresses: 2,
        relays: 1,
        open_conversations: 1,
        messages: { queued: 0, leased: 0, accepted: 0, dead: 0, ambiguous: 0 },
        directions: [
          { source_engine: "codex", target_engine: "claude", total: 3, pending: 0, completed: 3, dead: 0, ambiguous: 0 },
          { source_engine: "claude", target_engine: "codex", total: 2, pending: 0, completed: 2, dead: 0, ambiguous: 0 },
        ],
        delivery: "ordered_at_least_once",
      };
    case "/admin/agent-messaging/addresses":
      return {
        addresses: [
          {
            id: "address-codex",
            address: "agent:codex-console",
            alias: "agent:console",
            engine: "codex",
            host_id: 1,
            fqdn: "console.example.test",
            username: "operator",
            cwd: "/srv/console",
            enabled: true,
            continuity: "native",
            readiness: "live",
            adapter_protocol: "mcp",
            adapter_capabilities: null,
            binding_generation: 1,
            current_session_id: "session-1",
            receive_heartbeat_at: "2026-08-01T08:00:00Z",
            last_seen_at: "2026-08-01T08:00:00Z",
            created_at: "2026-08-01T08:00:00Z",
            queue_depth: 0,
            host_secure: true,
            host_window_until: null,
            host_status: "active",
            host_engines: ["codex"],
            eligible: true,
            ineligible_reason: null,
          },
        ],
      };
    case "/admin/agent-messaging/conversations":
      return {
        conversations: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            address_a_id: "address-codex",
            address_b_id: "address-claude",
            created_by_address_id: "address-codex",
            status: "open",
            next_sequence: 3,
            last_activity_at: "2026-08-01T08:00:00Z",
            canceled_by: null,
            cancel_reason: null,
            canceled_at: null,
            created_at: "2026-08-01T08:00:00Z",
            updated_at: "2026-08-01T08:00:00Z",
            address_a: { alias: "agent:console", address: "agent:codex-console" },
            address_b: { alias: "agent:review", address: "agent:claude-review" },
          },
        ],
      };
    case "/admin/agent-messaging/messages":
      return {
        messages: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            conversation_id: "11111111-1111-4111-8111-111111111111",
            sequence: 1,
            reply_to_message_id: null,
            redrive_of_message_id: null,
            sender: { alias: "agent:console", address: "agent:codex-console" },
            target: { alias: "agent:review", address: "agent:claude-review" },
            kind: "message",
            content_bytes: 48,
            status: "completed",
            attempts: 1,
            expires_at: "2026-08-01T09:00:00Z",
            last_error_code: null,
            accepted_at: "2026-08-01T08:00:00Z",
            completed_at: "2026-08-01T08:00:00Z",
            ambiguous_at: null,
            dead_at: null,
            expired_at: null,
            canceled_at: null,
            created_at: "2026-08-01T08:00:00Z",
            updated_at: "2026-08-01T08:00:00Z",
          },
        ],
      };
    default:
      return { status: "ok" };
  }
}

/**
 * Answer for one request, or `undefined` to fall through to the path-keyed
 * fixture. Taking the request body is what lets a test prove the console reacted
 * to a *setting* rather than merely re-fetching: a path-keyed stub returns the
 * same document whatever the operator changed, so nothing it asserts can tell an
 * auto-updating preview from a frozen one.
 */
export type FixtureOverride = (pathname: string, body: unknown) => Record<string, unknown> | undefined;

export async function installFixtures(page: Page, override?: FixtureOverride): Promise<void> {
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!request.headers().accept?.includes("application/json")) return route.continue();
    const pathname = new URL(request.url()).pathname;
    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      body = undefined;
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(override?.(pathname, body) ?? fixture(pathname)),
    });
  });
}
