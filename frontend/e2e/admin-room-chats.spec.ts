import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const GROUP = "44444444-4444-4444-8444-444444444444",
  CONF = "55555555-5555-4555-8555-555555555555",
  AGENT = "11111111-1111-4111-8111-111111111111";
async function fixture(page: Page) {
  const now = new Date().toISOString();
  const member = {
    id: AGENT,
    name: "Liliana",
    engine: "codex",
    session_id: AGENT,
    reachable: true,
    role: "member",
  };
  const rooms = [
    {
      id: GROUP,
      kind: "group",
      title: "Release workshop",
      description: "A shared place for the next release.",
      status: "open",
      members: [member],
      created_at: now,
      last_activity_at: now,
      unread: 2,
    },
    {
      id: CONF,
      kind: "conference",
      title: "Architecture review",
      description: "Review the delivery model together.",
      status: "open",
      members: [member],
      created_at: now,
      last_activity_at: now,
      owner_admin_id: 1,
      deadline_at: new Date(Date.now() + 3600000).toISOString(),
    },
  ];
  const events: Record<string, unknown>[] = [
    {
      id: "66666666-6666-4666-8666-666666666666",
      actor: `agent:${AGENT}`,
      name: "Liliana",
      created_at: now,
      content:
        "The release candidate is ready for review.\n\n- Authentication checks passed\n- The room keeps its own history\n\nWhich scenario should we exercise next?",
      attachments: [],
      kind: "chat",
    },
  ];
  const sends: Record<string, unknown>[] = [];
  // The member's agent: rooms only count as current while it is an online agent.
  const agents: Record<string, unknown>[] = [{
    id: AGENT, engine: "codex", host_id: 1, host: "biest.example", username: "operator", cwd: "/srv/fleet",
    invocation_kind: "interactive", upstream_session_id: null, status: "active", presence: "listening",
    relay_ready: true, relay_enabled: true, relay_heartbeat_at: now, active_turn_id: null, active_turn_started_at: null,
    started_at: now, heartbeat_at: now, last_event_at: now, attention: null, ended_at: null, expires_at: null,
    close_requested_at: null, close: null, read_only: false, pending_prompt: null,
    work: { task: null, branch: null, target_branch: null, declared_paths: [], worktree_path: null, address: null, address_alias: null },
  }];
  let loseResponse = false;
  await page.routeWebSocket("**/room-ws", () => {});
  await page.addInitScript(() => {
    class MockSource extends EventTarget {
      close() {}
    }
    window.EventSource = MockSource as unknown as typeof EventSource;
  });
  await page.route("**/admin/**", async (route) => {
    const req = route.request();
    if (!req.headers().accept?.includes("application/json"))
      return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/admin/auth/status")
      return json({
        authenticated: true,
        enforced: true,
        user: { id: 1, username: "Chris", roles: ["owner"] },
        capabilities: [
          "agent_portal.read",
          "agent_portal.manage",
          "agent_portal.reveal_transcript",
          "agent_messaging.read",
          "agent_messaging.manage",
          "agent_messaging.reveal_content",
        ],
      });
    if (path === "/admin/setup/status")
      return json({
        setup_complete: true,
        critical_complete: true,
        checks: [],
        next_actions: [],
        wizard: { completed_at: now },
      });
    if (path === "/admin/ws/info")
      return json({
        enabled: true,
        url: new URL("/room-ws", req.url()).href.replace(/^http/, "ws"),
      });
    if (path === "/admin/agent-sessions")
      return json({ enabled: true, generated_at: now, sessions: agents });
    if (path === "/admin/agent-messaging/chats") {
      const closed = rooms.filter(
        (r) =>
          r.kind === "conference" &&
          r.status === "adjourned" &&
          r.members.every((m) => !m.reachable),
      );
      const history = new URL(req.url()).searchParams.get("view") === "history";
      return json({
        enabled: true,
        rooms: history ? closed : rooms.filter((r) => !closed.includes(r)),
        has_more: false,
      });
    }
    if (path === "/admin/agent-messaging/addresses")
      return json({
        addresses: [
          {
            ...member,
            address: `agent:${AGENT}`,
            alias: null,
            fqdn: "biest.example",
          },
        ],
      });
    if (path === "/admin/agent-messaging/chats/read") {
      const body = req.postDataJSON();
      return json({
        room: rooms.find((r) => r.id === body.room_id),
        events,
        next_before: null,
      });
    }
    if (path === "/admin/agent-messaging/chats/send") {
      const b = req.postDataJSON();
      sends.push(b);
      if (loseResponse) {
        loseResponse = false;
        return route.abort("failed");
      }
      if (!events.some((e) => e.id === b.client_request_id))
        events.push({
          id: b.client_request_id,
          actor: "admin:1",
          name: "Chris",
          created_at: new Date().toISOString(),
          content: b.content,
          attachments: b.attachments,
          kind: "chat",
        });
      return json({ id: b.client_request_id });
    }
    if (path === "/admin/agent-messaging/chats/manage") {
      const b = req.postDataJSON();
      if (b.action === "close") rooms[1].status = "adjourning";
      return json({ room_id: b.room_id });
    }
    if (path === "/admin/agent-messaging/chats/create")
      return json({ room_id: GROUP });
    return json({});
  });
  return {
    rooms,
    agents,
    events,
    sends,
    dropNext: () => {
      loseResponse = true;
    },
  };
}
test("History keeps closed conferences readable independently of the session toolbar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await fixture(page);
  state.rooms[1].status = "adjourned";
  // The members share one object; the conference needs its own unreachable copy.
  state.rooms[1].members = [{ ...state.rooms[1].members[0], reachable: false }];
  await page.goto("/admin/agents");
  await expect(page.locator(`#room-${GROUP}`)).toBeVisible();
  await expect(page.locator(`#room-${CONF}`)).toHaveCount(0);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "History", exact: true }),
  ).toBeVisible();
  await expect(page.locator(`#room-${CONF}`)).toBeVisible();
  await expect(page.locator(`#room-${GROUP}`)).toHaveCount(0);
  // History lists retained conferences only, never direct chats.
  await expect(page.getByRole("heading", { name: "Direct messages" })).toHaveCount(0);
  await page.locator(`#room-${CONF}`).click();
  await expect(page.getByText("This conference has ended.")).toBeVisible();
  await page
    .getByRole("region", { name: "Client directory" })
    .getByRole("button", { name: "Active", exact: true })
    .click();
  await expect(page.locator(`#room-${GROUP}`)).toBeVisible();
  await expect(page.locator(`#room-${CONF}`)).toHaveCount(0);
});
test("current rooms need a reachable member that is also an online agent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await fixture(page);
  state.agents[0].presence = "offline";
  await page.goto("/admin/agents");
  await expect(page.getByText("No agents online.")).toBeVisible();
  // The roster still says reachable, but the agent behind it is not online.
  await expect(page.locator(`#room-${GROUP}`)).toHaveCount(0);
  await expect(page.locator(`#room-${CONF}`)).toHaveCount(0);
});
test("shared rooms sit beside direct chats; switching preserves drafts and targeted retry IDs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await fixture(page);
  await page.goto("/admin/agents");
  await page.locator(`#room-${GROUP}`).click();
  await expect(
    page.getByRole("heading", { name: "Release workshop" }),
  ).toBeVisible();
  await page
    .getByLabel("Message this conversation")
    .fill("Review the edge cases");
  await page.getByLabel("Ask an agent").selectOption(AGENT);
  await page.locator(`#room-${CONF}`).click();
  await page.getByLabel("Message this conversation").fill("Conference draft");
  await page.locator(`#room-${GROUP}`).click();
  await expect(page.getByLabel("Message this conversation")).toHaveValue(
    "Review the edge cases",
  );
  state.dropNext();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry send" })).toBeVisible();
  await page.getByRole("button", { name: "Retry send" }).click();
  await expect.poll(() => state.sends.length).toBe(2);
  expect(state.sends[0].client_request_id).toBe(
    state.sends[1].client_request_id,
  );
  expect(state.sends[0].recipients).toEqual([AGENT]);
  expect(state.sends[0].ask_all).toBe(false);
  await expect(page.getByLabel("Message this conversation")).toHaveValue("");
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Conversation type").selectOption("conference");
  await page.getByLabel("Topic", { exact: true }).fill("Design review");
  await page.getByRole("button", { name: "Open conference" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
test("room drafts survive chat switches and protect leaving the workspace", async ({
  page,
}) => {
  await fixture(page);
  await page.goto(`/admin/agents?room=${GROUP}`);
  await page.getByLabel("Message this conversation").fill("Keep this draft");
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.locator(`#room-${CONF}`).click();
  await expect(
    page.getByRole("heading", { name: "Architecture review" }),
  ).toBeVisible();
  await page.locator(`#room-${GROUP}`).click();
  await expect(page.getByLabel("Message this conversation")).toHaveValue(
    "Keep this draft",
  );
  expect(dialogs).toEqual([]);
  await page.locator('a[href="/admin/dashboard"]').first().click();
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(page.getByLabel("Message this conversation")).toHaveValue(
    "Keep this draft",
  );
  await expect(page).toHaveURL(new RegExp(`room=${GROUP}`));
});
test("operator conference closes gracefully", async ({ page }) => {
  await fixture(page);
  await page.goto(`/admin/agents?room=${CONF}`);
  await page.getByRole("button", { name: "Conversation details" }).click();
  await page
    .getByRole("button", { name: "End conference", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "End Architecture review?" })
    .getByRole("button", { name: "End conference", exact: true })
    .click();
  await expect(
    page.getByText(
      "This conference is closing. Outstanding answers can still arrive.",
    ),
  ).toBeVisible();
});
for (const width of [1920, 1440, 768, 390, 320])
  for (const theme of ["light", "dark"] as const)
    test(`room conversation ${width}px ${theme}: reflow and accessibility`, async ({
      page,
    }, info) => {
      await page.setViewportSize({
        width,
        height:
          width === 1920
            ? 1080
            : width === 1440
              ? 900
              : width === 768
                ? 1024
                : 844,
      });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await fixture(page);
      await page.goto(`/admin/agents?room=${GROUP}`);
      await expect(page.getByLabel("Message this conversation")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      const results = await new AxeBuilder({ page })
        .include('[aria-label="Shared conversation"]')
        .analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`shared-room-${width}-${theme}.png`),
        fullPage: true,
      });
      if (width < 1024) {
        await page
          .getByRole("button", { name: "Back to conversations" })
          .click();
        await expect(page.locator(`#room-${CONF}`)).toBeVisible();
      }
    });
