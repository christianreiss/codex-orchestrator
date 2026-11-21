import { ownerStream } from "./owner-stream";
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
  const rooms: (Record<string, unknown> & { id: string; kind: string; status: string; members: typeof member[] })[] = [
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
      reactions: [],
    },
  ];
  const sends: Record<string, unknown>[] = [];
  let pinned: string[] = [];
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
  let emit: ((data: string) => void) | undefined;
  await page.routeWebSocket("**/room-ws", ws => { ownerStream(ws); emit = data => ws.send(data); });
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
          (r.status === "closed" && !!r.workflow_run_id) || (r.kind === "conference" &&
          r.status === "adjourned" &&
          r.members.every((m) => !m.reachable)),
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
        pinned,
      });
    }
    if (path.endsWith("/reactions")) {
      const b = req.postDataJSON();
      const reactions = b.on ? [{ emoji: b.emoji, count: 1, mine: true }] : [];
      events[0].reactions = reactions;
      return json({ reactions });
    }
    if (path.endsWith("/pin")) {
      const b = req.postDataJSON();
      pinned = b.on ? [String(events[0].id)] : [];
      return json({ pinned });
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
          reply_to: b.reply_to,
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
    update: async () => {
      await expect.poll(() => Boolean(emit)).toBe(true);
      emit!(JSON.stringify({ type: "agent_room_chat.changed", payload: { room_id: GROUP }, ts: new Date().toISOString() }));
    },
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
  const history = page.getByRole("region", { name: "Client directory" }).getByRole("button", { name: "History", exact: true });
  await history.click();
  await expect(history).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "History", exact: true }),
  ).toBeVisible();
  await expect(page.locator(`#room-${CONF}`)).toBeVisible();
  await expect(page.locator(`#room-${GROUP}`)).toHaveCount(0);
  // History lists retained conferences only, never direct chats.
  await expect(page.getByRole("heading", { name: "Direct messages" })).toHaveCount(0);
  await page.locator(`#room-${CONF}`).click();
  await expect(page.getByText("This conference has ended.")).toBeVisible();
  // History is a filter chip: pressing it again returns to current conversations.
  await history.click();
  await expect(history).toHaveAttribute("aria-pressed", "false");
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
  await page.getByRole("button", { name: "Choose recipients" }).click();
  await page.getByRole("radio", { name: "Choose agents", exact: true }).check();
  await page.getByRole("checkbox", { name: "Liliana" }).check();
  await page.keyboard.press("Escape");
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


test("managed run groups link to their report, fence generic membership and retain closed history", async ({page}) => {
  const state=await fixture(page);
  state.rooms[0].workflow_managed=true;state.rooms[0].workflow_run_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await page.goto(`/admin/agents?view=live&room=${GROUP}`);
  await expect(page.getByRole("link",{name:"Run report and controls"})).toHaveAttribute("href","/admin/workflows/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  await page.getByRole("button",{name:"Conversation details"}).click();
  await expect(page.getByText("Invitations, membership and closure are managed by the run.",{exact:false})).toBeVisible();
  await expect(page.getByText("Invite an agent",{exact:true})).toHaveCount(0);await expect(page.getByRole("button",{name:"Remove from room"})).toHaveCount(0);
  await page.keyboard.press("Escape");state.rooms[0].status="closed";await page.reload();
  await expect(page.getByText("This run is complete. Its group is closed; history remains readable.")).toBeVisible();
  await expect(page.getByLabel("Message this conversation")).toHaveCount(0);
  await expect(page.getByText("The release candidate is ready for review.",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:"History",exact:true}).click();await expect(page.locator(`#room-${GROUP}`)).toBeVisible();
});

test("one Send defaults to everyone, notes are explicit, and replies select the author", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/admin/agents?room=${GROUP}`);
  const input = page.getByLabel("Message this conversation");
  const target = page.getByRole("button", { name: "Choose recipients" });
  await expect(target).toHaveText("To: Everyone");
  await expect(page.getByRole("button", { name: "Ask the room" })).toHaveCount(0);
  await input.fill("Review together");
  await input.press("Enter");
  expect(state.sends).toHaveLength(0);
  await input.press("Control+Enter");
  await expect.poll(() => state.sends.length).toBe(1);
  expect(state.sends[0]).toMatchObject({ ask_all: true, recipients: [] });
  await expect(input).toHaveValue("");
  await target.click();
  await page.getByRole("radio", { name: "Post without requesting replies" }).check();
  await page.keyboard.press("Escape");
  await input.fill("For the record");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(2);
  expect(state.sends[1]).toMatchObject({ ask_all: false, recipients: [] });
  await expect(target).toHaveText("To: Everyone");
  const original = page.getByRole("article", { name: "Message from Liliana" });
  await original.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(target).toHaveText("To: Liliana");
  await input.fill("Please explain the authentication checks");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(3);
  expect(state.sends[2]).toMatchObject({ ask_all: false, recipients: [AGENT], reply_to: "66666666-6666-4666-8666-666666666666" });
  const quote = page.getByRole("button", { name: /Reply to Liliana/ });
  await expect(quote).toContainText("release candidate");
  await quote.click();
  await expect(original).toBeFocused();
  await page.getByRole("article", { name: "Message from Chris" }).first().getByRole("button", { name: "Reply", exact: true }).click();
  await expect(target).toHaveText("To: Everyone");
});

test("an empty explicit selection cannot send and unavailable agents stay selectable", async ({ page }) => {
  const state = await fixture(page);
  state.rooms[0].members.push({ ...state.rooms[0].members[0], id: "77777777-7777-4777-8777-777777777777", name: "Morgan", reachable: false });
  await page.goto(`/admin/agents?room=${GROUP}`);
  await page.getByLabel("Message this conversation").fill("A targeted question");
  await page.getByRole("button", { name: "Choose recipients" }).click();
  await page.getByRole("radio", { name: "Choose agents", exact: true }).check();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Morgan · unavailable" }).check();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(1);
  expect(state.sends[0].recipients).toEqual(["77777777-7777-4777-8777-777777777777"]);
});

for (const width of [320, 390, 1440]) for (const theme of ["light", "dark"]) {
  test(`long chat ${width}px ${theme}: readable previews, full copy, preserved expansion`, async ({ page, browserName, context }, info) => {
    if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem("codex.theme", theme), theme);
    const state = await fixture(page);
    const text = "## Review outcome\n\n" + Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1}: Authentication and delivery evidence remain independently verifiable.\n\n`).join("") + "```sh\n" + "example-".repeat(80) + "\n```\n\n| Check | Outcome |\n| --- | --- |\n| Auth | Passed |\n\nFinal evidence marker.";
    state.events[0].content = text;
    await page.goto(`/admin/agents?room=${GROUP}`);
    const message = page.getByRole("article", { name: "Message from Liliana" });
    const expand = message.getByRole("button", { name: "Show full message" });
    await expect(expand).toBeVisible();
    await expect(message.locator(".folded")).toHaveCount(1);
    await expect(message.getByRole("button", { name: "Copy code" })).toHaveCount(0);
    await message.getByRole("button", { name: "Message actions" }).click();
    await page.getByRole("button", { name: "Copy full message", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Copied full message" })).toBeVisible();
    await page.keyboard.press("Escape");
    const composer = page.getByRole("textbox", { name: "Message this conversation" });
    await composer.focus();
    await page.keyboard.press("Control+v");
    await expect(composer).toHaveValue(text);
    await composer.fill("");
    await expand.click();
    await expect(message.getByText("Final evidence marker.", { exact: true })).toBeVisible();
    await expect(message.getByRole("button", { name: "Copy code" })).toBeVisible();
    await page.getByRole("button", { name: "Show less" }).click();
    await expect(expand).toBeVisible();
    await page.screenshot({ path: info.outputPath(`long-chat-${width}-${theme}.png`), fullPage: true });
    await expand.click();
    // Room switches remount the conversation, but keep expansion state.
    if (width < 1024) await page.getByRole("button", { name: "Back to conversations" }).click();
    await page.locator(`#room-${CONF}`).click();
    if (width < 1024) await page.getByRole("button", { name: "Back to conversations" }).click();
    await page.locator(`#room-${GROUP}`).click();
    await expect(page.getByRole("button", { name: "Show less" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const axe = await new AxeBuilder({ page }).include('[aria-label="Shared conversation"]').analyze();
    expect(axe.violations).toEqual([]);
  });
}

test("new messages retain the reading position, and unresolvable replies explain missing history", async ({ page }) => {
  const state = await fixture(page);
  state.events.push(...Array.from({ length: 12 }, (_, i) => ({ ...state.events[0], id: `event-${i}`, created_at: new Date(Date.now() + i + 1).toISOString(), content: `Review ${i}. ` + "Further evidence. ".repeat(25) })));
  state.events[0].reply_to = "older-event";
  state.events[0].deliveries = [{ address_id: AGENT, status: "unreachable" }];
  await page.goto(`/admin/agents?room=${GROUP}`);
  const history = page.getByRole("region", { name: "Conversation history" });
  await history.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
  await expect(page.getByText("Load earlier history", { exact: false })).toBeVisible();
  await expect(page.getByText("Some agents could not be reached")).toBeVisible();
  await expect(page.getByText("Delivery details · 1 recipient")).toBeVisible();
  state.events.push({ ...state.events[0], id: "latest-event", reply_to: undefined, deliveries: [], created_at: new Date(Date.now() + 50).toISOString(), content: "A new contribution" });
  await state.update();
  await expect(history).toContainText("A new contribution");
  expect(await history.evaluate(node => node.scrollTop)).toBeLessThan(10);
  await expect(page.getByRole("button", { name: "New messages ↓" })).toBeVisible();
});

test("More keeps reactions and pins reachable by keyboard and copy failures visible", async ({ page }) => {
  await fixture(page);
  await page.goto(`/admin/agents?room=${GROUP}`);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }); });
  const message = page.getByRole("article", { name: "Message from Liliana" });
  const more = message.getByRole("button", { name: "Message actions" });
  await more.focus(); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Copy full message", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Could not copy." })).toBeVisible();
  await page.getByRole("button", { name: "React", exact: true }).click();
  await page.getByRole("button", { name: "React with 👍", exact: true }).click();
  await expect(message.getByRole("button", { name: /1 reaction, including yours/ })).toBeVisible();
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(page.getByRole("button", { name: /1 pinned message/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
});
