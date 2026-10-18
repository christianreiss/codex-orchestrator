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
      return json({ enabled: true, generated_at: now, sessions: [] });
    if (path === "/admin/agent-messaging/chats")
      return json({ enabled: true, rooms, has_more: false });
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
    events,
    sends,
    dropNext: () => {
      loseResponse = true;
    },
  };
}
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
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : width === 1440 ? 900 : width === 768 ? 1024 : 844 });
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
