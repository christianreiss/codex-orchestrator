import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const user = {
  id: 1,
  username: "operator",
  name: "Console Operator",
  access_level: "owner",
  roles: ["owner"],
};

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
    case "/admin/overview":
      return {
        totals: { hosts: 2 },
        last_refresh: "2026-08-01T08:00:00Z",
        versions: { cdx_version_available: "1.0.0", claude_version_available: "2.0.0" },
        version_distribution: { codex: [], claude: [], install: { both: 1, codex_only: 1, claude_only: 0, neither: 0 } },
      };
    case "/admin/insecure-approvals/pending":
      return { requests: [] };
    case "/admin/projects/state":
      return { enabled: true };
    case "/admin/projects":
      return {
        projects: [{ slug: "fleet-console", title: "Fleet console", description: "Admin redesign", updated_at: "2026-08-01T08:00:00Z", latest_seq: 4 }],
      };
    case "/admin/skills":
      return { skills: [{ slug: "fleet-ops", display_name: "Fleet operations", description: "Operator runbook", status: "ok" }] };
    case "/admin/hosts":
      return { hosts: [] };
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
            host_enabled: true,
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

async function installFixtures(page: Page): Promise<void> {
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!request.headers().accept?.includes("application/json")) return route.continue();
    const pathname = new URL(request.url()).pathname;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture(pathname)) });
  });
}

test.beforeEach(async ({ page }) => {
  await installFixtures(page);
});

test("desktop shell exposes direct task navigation and the command palette", async ({ page }) => {
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Overview", { exact: true })).toBeVisible();
  }

  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(primary.getByRole("link", { name: "Engines" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Policies" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Agent Messaging" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Fleet Instructions" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Admin Users" })).toBeVisible();

  await page.keyboard.press("Control+K");
  await expect(page.getByPlaceholder("Type a command or search hosts, projects, skills, users…")).toBeVisible();
  await expect(page.getByText("Agent Portal", { exact: true })).toBeVisible();
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

test("neutral configuration template has no serious Axe findings", async ({ page }) => {
  await page.goto("/admin/account/theme");
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(page.getByText("System", { exact: true })).toBeVisible();
  await expect(page.getByText("Light", { exact: true })).toBeVisible();
  await expect(page.getByText("Dark", { exact: true })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""))).toEqual([]);
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
