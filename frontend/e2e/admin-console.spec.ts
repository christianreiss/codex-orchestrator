import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const user = {
  id: 1,
  username: "operator",
  name: "Console Operator",
  access_level: "owner",
  roles: ["owner"],
};

const RENDERED_AGENTS_CONTENT =
  "# Fleet policy\n\nRendered for `console.example.test`.\n\n- Preserve unrelated changes.\n" +
  "- Keep every rendered rule readable.\n".repeat(32);

const BUILDER_STATE = {
  schema_version: 1,
  template_id: "fleet-standard",
  template_version: 1,
  enabled_modules: ["operating_contract", "security", "midnight_rule"],
  custom_instructions: "",
};

const SECURITY_LEVELS_STANDARD = {
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

const SECURITY_CATALOG = {
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
const PROVENANCE_DOC = [
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

const PROVENANCE_ENTRIES = [
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

const BUILDER_CATALOG = {
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
const CANONICAL_DESTINATIONS = [
  { path: "/dashboard", heading: "Overview", title: "Overview" },
  { path: "/logs/events", heading: "Activity", title: "Activity / Audit trail" },
  { path: "/hosts", heading: "Hosts", title: "Hosts" },
  { path: "/engines", heading: "Engines", title: "Engines" },
  { path: "/policies", heading: "Policies", title: "Policies" },
  { path: "/projects", heading: "Projects", title: "Projects" },
  { path: "/agent-messaging", heading: "Agent Messaging", title: "Agent Messaging" },
  { path: "/agent-portal", heading: "Agent Portal", title: "Agent Portal" },
  { path: "/skills", heading: "Skills", title: "Skills" },
  { path: "/instructions", heading: "Fleet Instructions", title: "Fleet Instructions" },
  { path: "/memories", heading: "Memories", title: "Memories" },
  { path: "/subagents", heading: "Subagents", title: "Subagents" },
  { path: "/commands", heading: "Commands", title: "Commands" },
  { path: "/output-styles", heading: "Output Styles", title: "Output Styles" },
  { path: "/api-keys", heading: "API Access", title: "API Access" },
  { path: "/secrets", heading: "Secrets", title: "Secrets" },
  { path: "/users", heading: "Admin Users", title: "Admin Users" },
  { path: "/manual", heading: "Manual", title: "Manual" },
  { path: "/account/password", heading: "Password", title: "Account / Password" },
] as const;

function fixture(pathname: string): Record<string, unknown> {
  switch (pathname) {
    case "/admin/auth/status":
      return { authenticated: true, enforced: true, user, roles: ["owner"] };
    case "/admin/setup/status":
      return { setup_complete: true, critical_complete: true, checks: [], next_actions: [] };
    case "/admin/ws/info":
      return { enabled: false };
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
    case "/admin/projects":
      return {
        projects: [{ slug: "fleet-console", title: "Fleet console", description: "Admin redesign", updated_at: "2026-08-01T08:00:00Z", latest_seq: 4 }],
      };
    case "/admin/projects/fleet-console":
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
type FixtureOverride = (pathname: string, body: unknown) => Record<string, unknown> | undefined;

async function installFixtures(page: Page, override?: FixtureOverride): Promise<void> {
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

async function expectNoSeriousAxeFindings(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? "")),
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await installFixtures(page);
});

test("every canonical destination deep-links into a bounded desktop workspace", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${page.url()}: ${error.stack ?? error.message}`));

  for (const destination of CANONICAL_DESTINATIONS) {
    await page.goto(`/admin${destination.path}`);
    await expect(page.getByRole("heading", { name: destination.heading, level: 1, exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveTitle(`${destination.title} · Codex Orchestrator`);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  }

  expect(pageErrors).toEqual([]);
});

test("desktop shell exposes direct task navigation and the command palette", async ({ page }) => {
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Codex CLI update available", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Overview", { exact: true })).toBeVisible();
  }

  // The sidebar groups its destinations and opens only the group holding the
  // current route, so reaching another section costs one disclosure click.
  // Assert that contract rather than a flat list: every group is present as a
  // header, and expanding it reveals the destinations it owns. (This assertion
  // was written against the older flat sidebar and had been failing silently
  // since the grouped one landed — nothing ran the browser suite.)
  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  const destinations: Array<[string, string[]]> = [
    ["Fleet", ["Hosts", "Engines", "Policies"]],
    ["Coordinate", ["Projects", "Agent Messaging", "Agent Portal"]],
    ["Knowledge", ["Skills", "Fleet Instructions"]],
    ["Access", ["Admin Users"]],
  ];
  for (const [group, links] of destinations) {
    const trigger = primary.getByRole("button", { name: group, exact: true });
    await expect(trigger).toBeVisible();
    if ((await trigger.getAttribute("data-state")) !== "open") await trigger.click();
    for (const link of links) {
      await expect(primary.getByRole("link", { name: link, exact: true })).toBeVisible();
    }
  }

  await page.keyboard.press("Control+K");
  await expect(page.getByPlaceholder("Type a command or search hosts, projects, skills, users…")).toBeVisible();
  await expect(page.getByText("Agent Portal", { exact: true })).toBeVisible();
});

test("desktop navigation switches from Skills to Fleet Instructions with a legacy host list", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/admin/skills");
  await expect(page.getByRole("heading", { name: "Skills", level: 1, exact: true })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Fleet Instructions" })
    .click();

  await expect(page).toHaveURL(/\/admin\/instructions$/);
  await expect(page.getByRole("heading", { name: "Fleet Instructions", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview effective draft" })).toBeEnabled();
  expect(pageErrors).toEqual([]);
});

test("rendered AGENTS preview is a document and copies its exact Markdown", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/admin/instructions");
  await expect(page.getByRole("heading", { name: "Fleet Instructions", level: 1, exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("switch", { name: "Fleet identity (required)" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).toBeChecked();
  await page.getByRole("switch", { name: "Security and trust boundaries" }).click();
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).not.toBeChecked();
  await page.getByRole("button", { name: "Preview effective draft" }).click();

  const dialog = page.getByRole("dialog", { name: "Effective AGENTS.md draft" });
  await expect(dialog).toBeVisible();
  const document = dialog.getByRole("article", { name: "Effective AGENTS.md draft document" });
  await expect(document.getByRole("heading", { name: "Fleet policy", level: 1 })).toBeVisible();
  await expect(document.getByText("Preserve unrelated changes.")).toBeVisible();
  await expect(document.getByRole("region", { name: "Rendered AGENTS.md content" })).toHaveAttribute(
    "tabindex",
    "0",
  );
  await expect(dialog.getByRole("textbox", { name: "Current rendered AGENTS.md preview" })).toHaveCount(0);
  await expectNoSeriousAxeFindings(page);

  await dialog.getByRole("button", { name: "Copy document" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(RENDERED_AGENTS_CONTENT);
});

test("every setting updates the effective preview without a button press", async ({ page }) => {
  // The render answer embeds the settings it was asked about, so an assertion on
  // the preview text is an assertion that the change actually reached the server
  // and came back — not merely that something re-rendered.
  await installFixtures(page, (pathname, body) => {
    if (pathname !== "/admin/agents/render") return undefined;
    const sent = (body ?? {}) as {
      security_levels?: Record<string, number>;
      composition?: { enabled_modules?: string[]; custom_instructions?: string };
    };
    const autonomy = sent.security_levels?.autonomy ?? "?";
    const modules = sent.composition?.enabled_modules?.length ?? 0;
    const custom = sent.composition?.custom_instructions ?? "";
    return {
      ...fixture(pathname),
      content: `# Fleet policy\n\nautonomy=${autonomy} modules=${modules} custom=${custom}\n`,
    };
  });

  await page.goto("/admin/instructions");
  const preview = page.getByRole("region", { name: "Effective AGENTS.md preview content" });
  await expect(preview).toContainText("autonomy=3 modules=3", { timeout: 15_000 });

  // A posture slider — the setting that reached no preview at all before.
  await page.getByRole("slider", { name: "Working without asking level" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(preview).toContainText("autonomy=4", { timeout: 10_000 });

  // A module switch.
  await page.getByRole("switch", { name: "Security and trust boundaries" }).click();
  await expect(preview).toContainText("modules=2", { timeout: 10_000 });

  // And free text.
  await page.getByRole("textbox", { name: "Custom instructions" }).fill("no reactors");
  await expect(preview).toContainText("custom=no reactors", { timeout: 10_000 });

  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
});

test("the generation master switch reaches the effective preview without a button press", async ({ page }) => {
  // The mode never travels in the render request — the server reads it from
  // fleet settings — so the fixture holds it the same way, and the preview text
  // is evidence that the POST landed and a fresh render came back for it.
  let mode = "managed";
  await installFixtures(page, (pathname, body) => {
    if (pathname === "/admin/agents-generation-mode") {
      const sent = (body ?? {}) as { mode?: string };
      if (sent.mode) mode = sent.mode;
      return { status: "ok", mode, modes: ["managed", "manual", "off"] };
    }
    if (pathname === "/admin/agents") return { ...fixture(pathname), generation_mode: mode };
    if (pathname !== "/admin/agents/render") return undefined;
    const sent = (body ?? {}) as { composition?: { enabled_modules?: string[] } };
    // Standing in for the server, which composes the draft with no modules at
    // `off` and hands the rest of the document over unchanged.
    const modules = mode === "off" ? 0 : sent.composition?.enabled_modules?.length ?? 0;
    return { ...fixture(pathname), content: `# Fleet policy\n\nmode=${mode} modules=${modules}\n` };
  });

  await page.goto("/admin/instructions");
  const preview = page.getByRole("region", { name: "Effective AGENTS.md preview content" });
  await expect(preview).toContainText("mode=managed modules=3", { timeout: 15_000 });

  await page.getByRole("button", { name: "Disabled", exact: true }).click();
  await expect(preview).toContainText("mode=off modules=0", { timeout: 10_000 });
  // The selection is kept and visibly inert, not erased.
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).toBeDisabled();

  await page.getByRole("button", { name: "Generated", exact: true }).click();
  await expect(preview).toContainText("mode=managed modules=3", { timeout: 10_000 });
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).toBeEnabled();

  // Manual swaps the editor for the raw document, seeded from what is served.
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  const raw = page.getByRole("textbox", { name: "Hand-written Markdown document" });
  await expect(raw).toBeVisible();
  await expect(raw).toHaveValue("## Operating Contract (FAST)\n\nExecute and verify.\n");

  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
});

test("manual mode stores the bytes in the textarea, not the composed document", async ({ page }) => {
  // The dangerous direction of the switch: the builder is still holding a
  // composition, and Save must not write it over what the operator typed.
  let stored: unknown;
  await installFixtures(page, (pathname, body) => {
    if (pathname === "/admin/agents-generation-mode") return { status: "ok", mode: "manual", modes: ["managed", "manual", "off"] };
    if (pathname === "/admin/agents") return { ...fixture(pathname), generation_mode: "manual" };
    if (pathname !== "/admin/agents/store") return undefined;
    stored = body;
    return { status: "ok", version_id: 56, sha256: "f".repeat(64) };
  });

  await page.goto("/admin/instructions");
  const raw = page.getByRole("textbox", { name: "Hand-written Markdown document" });
  // Opens on the served base even though the stored version was built.
  await expect(raw).toHaveValue("## Operating Contract (FAST)\n\nExecute and verify.\n", { timeout: 15_000 });
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).toHaveCount(0);

  await raw.fill("# House rules\n\nMine, by hand.\n");
  // The canonical pane is "what this editor stores", so it follows the textarea
  // rather than the composition the builder is still holding.
  await page.getByRole("button", { name: "Canonical base" }).click();
  await expect(page.getByRole("heading", { name: "Stored canonical base" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Generated AGENTS.md base content" })).toContainText("House rules");

  // `.first()`: the retention card in the aside has a Save of its own.
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect.poll(() => stored).toEqual({ content: "# House rules\n\nMine, by hand.\n" });
});

test("a preview that cannot render says so once, in the pane, not once per keystroke", async ({ page }) => {
  // Every settings change mints a new query key, so a failing render fails again
  // for each one. As toasts that is a stream of them, and the place the operator
  // is looking would still show a stale document with nothing to explain it.
  let renders = 0;
  await installFixtures(page);
  await page.route("**/admin/agents/render", async (route) => {
    renders += 1;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
  });

  // Toasts auto-dismiss, so asserting a count of zero after the fact merely
  // waits for them to disappear and always passes. Count them as they arrive.
  await page.addInitScript(() => {
    (window as unknown as { __toasts: number }).__toasts = 0;
    const watch = (): void => {
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.matches("[data-sonner-toast]") || node.querySelector("[data-sonner-toast]")) {
              (window as unknown as { __toasts: number }).__toasts += 1;
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) watch();
    else document.addEventListener("DOMContentLoaded", watch);
  });

  await page.goto("/admin/instructions");
  const field = page.getByRole("textbox", { name: "Custom instructions" });
  await expect(field).toBeVisible({ timeout: 15_000 });
  for (const value of ["a", "ab", "abc", "abcd"]) await field.fill(value);

  await expect(page.getByText(/showing the last document that rendered/)).toHaveCount(1, { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __toasts: number }).__toasts)).toBe(0);
  // No retry storm either: a failed key is not retried three more times.
  expect(renders).toBeLessThanOrEqual(6);
});

test("a setting and the text it produces are visually linked, both ways", async ({ page }) => {
  await installFixtures(page, (pathname) =>
    pathname === "/admin/agents/render"
      ? {
          ...fixture(pathname),
          content: PROVENANCE_DOC,
          provenance: PROVENANCE_ENTRIES,
          axis_sections: { autonomy: ["hard_stops"], verification_waiver: ["hard_stops"] },
        }
      : undefined,
  );

  await page.goto("/admin/instructions");
  const preview = page.getByRole("region", { name: "Effective AGENTS.md preview content" });
  await expect(preview.getByRole("heading", { name: "Security and Trust Boundaries" })).toBeVisible({
    timeout: 15_000,
  });

  const active = preview.locator("[data-provenance-active]");
  await expect(active).toHaveCount(0);

  // Setting → text.
  await page.getByRole("group", { name: "Security and trust boundaries" }).hover();
  await expect(preview.locator('[data-provenance="module:security"][data-provenance-active]')).toHaveCount(2);
  await expect(preview.locator('[data-provenance="module:operating_contract"][data-provenance-active]')).toHaveCount(
    0,
  );
  // The separator between two modules belongs to neither of them.
  await expect(preview.locator("hr[data-provenance]")).toHaveCount(0);
  // Nothing is dimmed, and the title above the first block stays unattributed.
  await expect(preview.locator("h1[data-provenance]")).toHaveCount(0);
  await expectNoSeriousAxeFindings(page);

  // An axis names every section it reaches, and says how many.
  const axisRow = page.getByRole("group", { name: "Working without asking" });
  await expect(axisRow).toContainText("contributes to 1 block");
  await axisRow.hover();
  await expect(preview.locator('[data-provenance="policy:hard_stops"][data-provenance-active]')).toHaveCount(2);

  // Text → setting: a shared block outlines every axis feeding it, not one.
  await preview.getByRole("heading", { name: "Hard Stop Lines" }).hover();
  await expect(page.getByRole("group", { name: "Working without asking" })).toHaveClass(/ring-2/);
  await expect(page.getByRole("group", { name: "Skipping verification" })).toHaveClass(/ring-2/);
});

test("operator tables use the full workspace and the mobile menu retains all routes", async ({ page }) => {
  await page.goto("/admin/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("link", { name: "Fleet console" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("link", { name: /Output Styles/ })).toBeVisible();
  await expect(dialog.getByRole("link", { name: /Agent Portal/ })).toBeVisible();
});

test("hosts keep desktop data rows dense without losing the mobile summary", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/hosts");
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();

  const hostRow = page.getByRole("button", { name: /console\.example\.test/ });
  await expect(hostRow).toBeVisible();
  await expect(hostRow).toContainText("192.0.2.20 · #1");
  const desktopBox = await hostRow.boundingBox();
  expect(desktopBox).not.toBeNull();
  expect(desktopBox!.height).toBeLessThanOrEqual(40);
  await expectNoSeriousAxeFindings(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(hostRow).toBeVisible();
  const mobileBox = await hostRow.boundingBox();
  expect(mobileBox).not.toBeNull();
  expect(mobileBox!.height).toBeGreaterThanOrEqual(68);
});

test("neutral configuration template has no serious Axe findings", async ({ page }) => {
  await page.goto("/admin/account/theme");
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(page.getByText("System", { exact: true })).toBeVisible();
  await expect(page.getByText("Light", { exact: true })).toBeVisible();
  await expect(page.getByText("Dark", { exact: true })).toBeVisible();

  await expectNoSeriousAxeFindings(page);
});

test("Claude client settings use one full-width operator workflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/engines#claude-client");
  await expect(page.getByRole("heading", { name: "Engines", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Claude client", level: 2 })).toBeVisible();
  await expect(page.getByText("Fleet configuration", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Environment variables", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Permissions", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hooks", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "settings.json preview", level: 3 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "NAME" })).toHaveValue("OPERATIONS_MODE");
  await expect(page.getByText('"OPERATIONS_MODE": "managed"')).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await expectNoSeriousAxeFindings(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Claude client", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
});

test("engine policy settings stay sequential and show the effective scaling tier", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/engines#quota-enforcement");

  await expect(page.getByRole("heading", { name: "Quota and scaling", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quotas", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scaling", level: 3 })).toBeVisible();
  await expect(page.getByLabel("At %")).toHaveValue("75");
  await expect(page.locator("#scaling")).toContainText(/Current state:\s*active/);
  await expect(page.locator("#scaling")).toContainText(/Effective tier:\s*75%/);
  await expect(page.locator("#scaling")).toContainText(/Lane:\s*spark/);

  const quotaBox = await page.locator("#quotas").boundingBox();
  const scalingBox = await page.locator("#scaling").boundingBox();
  expect(quotaBox).not.toBeNull();
  expect(scalingBox).not.toBeNull();
  expect(scalingBox!.y).toBeGreaterThanOrEqual(quotaBox!.y + quotaBox!.height);
  expect(Math.abs(quotaBox!.x - scalingBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(quotaBox!.width - scalingBox!.width)).toBeLessThanOrEqual(1);
  await expectNoSeriousAxeFindings(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Scaling", level: 3 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save scaling" })).toBeVisible();
});

test("account security uses compact route-backed sections", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/account/password");
  const accountNav = page.getByRole("navigation", { name: "Account settings" });
  await expect(accountNav.getByRole("link", { name: "Password" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { name: "Change password", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reset by email", level: 2 })).toBeVisible();
  await expect(page.getByLabel("Current password")).toBeVisible();

  await page.goto("/admin/account/passkeys");
  await expect(accountNav.getByRole("link", { name: "Passkeys" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { name: "Registered credentials", level: 2 })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText("Operator laptop", { exact: true })).toBeVisible();
  await expect(page.getByText("Hardware key", { exact: true })).toBeVisible();
  await expectNoSeriousAxeFindings(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(accountNav.getByRole("link", { name: "Passkeys" })).toBeVisible();
});

test("project detail and standalone approval keep their task-focused layouts", async ({ page }) => {
  await page.goto("/admin/authoring/agents");
  await expect(page).toHaveURL(/\/admin\/instructions$/);
  await expect(page.getByRole("heading", { name: "Fleet Instructions" })).toBeVisible();

  await page.goto("/admin/projects/fleet-console");
  await expect(page.getByRole("heading", { name: "Fleet console", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "About", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Roster", level: 2 })).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue("Fleet console");
  await expect(page.getByRole("button", { name: "Save", exact: true }).first()).toBeDisabled();
  await expectNoSeriousAxeFindings(page);

  await page.goto("/admin/cli-auth/verify");
  await expect(page.getByRole("heading", { name: "Approve CLI session" })).toBeVisible();
  await expect(page.getByLabel("Device code")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();
  await expectNoSeriousAxeFindings(page);
});

test("host detail uses one ordered operational workspace", async ({ page }) => {
  await page.goto("/admin/hosts/1");
  await expect(page.getByRole("heading", { name: "console.example.test", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Identity & reachability", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Engines & versions", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Access & security", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fleet policy overrides", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Integrations", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mint installer" })).toBeVisible();

  await page.getByRole("button", { name: /Fleet policy overrides/ }).click();
  await expect(page.getByText("Reverse DNS", { exact: true })).toBeVisible();
  await expectNoSeriousAxeFindings(page);
});

test("project peer views keep records dense, readable, and inspectable", async ({ page }) => {
  // Todos became the board in migration 0026. The old URL is kept as a redirect
  // rather than a 404: it is in browser history and in muscle memory, and a
  // missing page reads as the work having disappeared.
  await page.goto("/admin/projects/fleet-console/todos");
  await expect(page).toHaveURL(/\/admin\/projects\/fleet-console\/board$/);
  await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Refresh runner image", level: 4 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Capture baseline", level: 4 })).toBeVisible();
  // A lane says which role it expects, and shows the holder of a claimed card —
  // the two things the board exists to make visible that a todo list could not.
  await expect(page.getByText("expects code", { exact: true })).toBeVisible();
  await expect(page.getByText(/code · chris on crane\.example/)).toBeVisible();
  await expect(page.getByText(/Claim reclaimed/)).toBeVisible();

  await page.goto("/admin/projects/fleet-console/notes");
  await expect(page.getByRole("heading", { name: "1 note", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rollout note", level: 3 })).toBeVisible();

  await page.goto("/admin/projects/fleet-console/files");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText("docs/rollout.md", { exact: true })).toBeVisible();

  await page.goto("/admin/projects/fleet-console/feedback");
  await expect(page.getByRole("heading", { name: /1 entry.*read-only log/, level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Runner label is stale", level: 3 })).toBeVisible();

  await page.goto("/admin/projects/fleet-console/activity");
  await page.getByRole("button", { name: /todo\.updated/ }).click();
  await expect(page.getByText("Entity:", { exact: true })).toBeVisible();
  await expectNoSeriousAxeFindings(page);
});

test("Agent Messaging uses peer URL-backed operational views", async ({ page }) => {
  await page.goto("/admin/agent-messaging?view=conversations");
  await expect(page.getByRole("heading", { name: "Agent Messaging", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Conversations" })).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("heading", { name: "Conversations" })).toBeVisible();
  await expect(page.getByText("agent:console ↔ agent:review")).toBeVisible();

  await page.getByRole("button", { name: "Deliveries", exact: true }).click();
  await expect(page).toHaveURL(/view=deliveries/);
  await expect(page).toHaveURL(/conversation_id=11111111-1111-4111-8111-111111111111/);
  await expect(page.getByRole("tab", { name: "Deliveries" })).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("heading", { name: "Deliveries" })).toBeVisible();
  await expect(page.getByLabel("Filter deliveries by conversation UUID")).toHaveValue(
    "11111111-1111-4111-8111-111111111111",
  );

  await page.getByRole("tab", { name: "Addresses" }).click();
  await expect(page).not.toHaveURL(/view=/);
  await expect(page.getByRole("heading", { name: "Addresses" })).toBeVisible();
  await expect(page.getByText("agent:console", { exact: true })).toBeVisible();
});
