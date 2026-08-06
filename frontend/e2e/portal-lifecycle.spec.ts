import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * The first browser coverage of /go.
 *
 * Every case here is an operator dead end that the unit tests cannot see,
 * because each one is about whether a control is reachable at all rather than
 * what a helper returns. The portal API is stubbed: this exercises the SPA, not
 * the service, which the integration suite already covers against a real
 * database.
 */

const USER = { id: 1, display_name: "Operator" };

interface AgentOverrides {
  presence?: string;
  relay_ready?: boolean;
  active_turn_started_at?: string | null;
  attention?: { since: string; summary: string } | null;
  ended_at?: string | null;
  read_only?: boolean;
  pending_prompt?: { id: string; question: string; options: string[]; version: number; created_at: string } | null;
}

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function agent(overrides: AgentOverrides = {}) {
  const now = new Date().toISOString();
  return {
    id: SESSION_ID,
    engine: "codex",
    host: "crane.example",
    username: "chris",
    cwd: "/srv/repo",
    status: "active",
    presence: "listening",
    relay_ready: true,
    active_turn_started_at: null,
    started_at: now,
    // Fresh, so the client's own staleness downgrade does not fire.
    heartbeat_at: now,
    last_event_at: now,
    ended_at: null,
    expires_at: null,
    read_only: false,
    attention: null,
    close_requested_at: null,
    close: null,
    pending_prompt: null,
    ...overrides,
  };
}

interface StubOptions {
  agent?: AgentOverrides;
  /** Error code the close endpoint should reject with, if any. */
  closeError?: string;
  events?: Array<Record<string, unknown>>;
}

interface Stub {
  calls: string[];
  bodies: Record<string, unknown>[];
}

async function stubPortal(page: Page, options: StubOptions = {}): Promise<Stub> {
  const stub: Stub = { calls: [], bodies: [] };
  const json = (route: Route, data: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

  await page.route("**/go/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    stub.calls.push(`${route.request().method()} ${path}`);
    const raw = route.request().postData();
    if (raw) stub.bodies.push(JSON.parse(raw) as Record<string, unknown>);

    if (path.endsWith("/api/state")) {
      return json(route, {
        status: "ok",
        data: { enabled: true, timings: { heartbeat_fresh_seconds: 45, relay_fresh_seconds: 60, retention_hours: 24 } },
      });
    }
    if (path.endsWith("/api/me")) return json(route, { status: "ok", data: { user: USER } });
    if (path.endsWith("/api/agents")) {
      return json(route, { status: "ok", data: { agents: [agent(options.agent)] } });
    }
    if (path.includes("/events") && !path.endsWith("/api/events")) {
      return json(route, { status: "ok", data: { events: options.events ?? [], next_cursor: 0 } });
    }
    if (path.endsWith("/api/events")) {
      // The SSE stream is not the subject here; hold it open and quiet.
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": idle\n\n" });
    }
    if (path.endsWith("/close/force")) {
      return json(route, {
        status: "ok",
        data: { forced: true, already_ended: false, status: "completed", ended_at: new Date().toISOString(), expires_at: null },
      });
    }
    if (path.endsWith("/close")) {
      if (options.closeError) {
        return json(route, { status: "error", code: options.closeError, message: "not reachable" }, 409);
      }
      return json(route, {
        status: "ok",
        data: { close_requested_at: new Date().toISOString(), close: { requested_at: new Date().toISOString(), state: "pending" } },
      });
    }
    if (path.endsWith("/messages") || path.includes("/prompts/")) {
      return json(route, { status: "ok", data: { message_id: "m1", status: "queued" } });
    }
    return json(route, { status: "ok", data: {} });
  });
  return stub;
}

const openPortal = async (page: Page) => {
  await page.goto("/go/");
  await expect(page.getByRole("heading", { name: /crane\.example/ })).toBeVisible();
};

test.describe("ending a session that cannot answer", () => {
  // The whole reason this file exists. "Force end" used to render only inside a
  // closing bar that appeared only after a cooperative close succeeded -- so
  // against an agent that could not accept one it was unreachable, and the
  // operator had no way to end the session at all. There is no cooperative
  // round trip to wait out here: the header goes straight to force.
  test("offers force directly for an agent that is already unreachable", async ({ page }) => {
    const stub = await stubPortal(page, { agent: { presence: "idle", relay_ready: false } });
    await openPortal(page);

    await page.getByRole("button", { name: "Close this channel" }).click();
    await expect(page.getByRole("heading", { name: "Force end this session?" })).toBeVisible();

    await page.getByRole("button", { name: /Force end|End session|Confirm/ }).click();
    await expect.poll(() => stub.calls.some((call) => call.endsWith("/close/force"))).toBe(true);
  });

  // The other half: the agent looked reachable when the dialog opened and was
  // gone by the time the request landed. That refusal must reopen in force with
  // the reason, not dead-end on an error banner.
  test("escalates to force when a cooperative close is refused mid-flight", async ({ page }) => {
    const stub = await stubPortal(page, { closeError: "agent_relay_unavailable" });
    await openPortal(page);

    await page.getByRole("button", { name: "Close this channel" }).click();
    await expect(page.getByRole("heading", { name: "Close this channel?" })).toBeVisible();
    await page.getByRole("button", { name: "Close channel", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Force end this session?" })).toBeVisible();
    await expect(page.getByText(/not reachable/)).toBeVisible();

    await page.getByRole("button", { name: /Force end|End session|Confirm/ }).click();
    await expect.poll(() => stub.calls.some((call) => call.endsWith("/close/force"))).toBe(true);
  });

  test("offers the cooperative close while the agent is listening", async ({ page }) => {
    await stubPortal(page);
    await openPortal(page);
    await page.getByRole("button", { name: "Close this channel" }).click();
    await expect(page.getByRole("heading", { name: "Close this channel?" })).toBeVisible();
  });
});

test.describe("the composer does not eat what you typed", () => {
  // The form used to be replaced outright by an explanatory sentence, so a
  // presence flip mid-keystroke destroyed the draft.
  test("keeps the textarea mounted when the agent stops accepting", async ({ page }) => {
    await stubPortal(page, { agent: { presence: "idle", relay_ready: false } });
    await openPortal(page);

    const box = page.getByRole("textbox", { name: "Message this agent" });
    await expect(box).toBeVisible();
    await box.fill("half-written thought");
    await expect(box).toHaveValue("half-written thought");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});

test.describe("prompt options are answers", () => {
  // Each option used to be a button whose only effect was focusing an empty
  // textarea, without even prefilling the text it displayed.
  test("clicking an option sends it", async ({ page }) => {
    const promptId = "22222222-2222-4222-8222-222222222222";
    const stub = await stubPortal(page, {
      agent: {
        pending_prompt: { id: promptId, question: "Deploy now?", options: ["Yes", "No"], version: 1, created_at: new Date().toISOString() },
      },
      events: [
        {
          cursor: 1,
          session_id: SESSION_ID,
          type: "waiting_input",
          source: "engine",
          payload: { question: "Deploy now?", allow_answer: true, prompt_id: promptId, options: ["Yes", "No"] },
          created_at: new Date().toISOString(),
        },
      ],
    });
    await openPortal(page);

    await page.getByRole("button", { name: "Yes", exact: true }).click();

    await expect.poll(() => stub.calls.some((call) => call.includes(`/prompts/${promptId}/answer`))).toBe(true);
    expect(stub.bodies.some((body) => body.answer === "Yes")).toBe(true);
  });
});

test.describe("presence tells the truth about a working agent", () => {
  test("shows Working rather than Not listening during a turn", async ({ page }) => {
    await stubPortal(page, {
      agent: {
        presence: "working",
        relay_ready: false,
        active_turn_started_at: new Date(Date.now() - 240_000).toISOString(),
      },
    });
    await openPortal(page);

    await expect(page.getByText("Working").first()).toBeVisible();
    await expect(page.getByText(/Running your instruction/).first()).toBeVisible();
    // A working agent is still sendable: it reads the queue when it returns.
    await expect(page.getByRole("textbox", { name: "Message this agent" })).toBeEnabled();
  });
});

test("the portal has no serious Axe findings", async ({ page }) => {
  await stubPortal(page);
  await openPortal(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const serious = results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
  expect(serious.map((violation) => violation.id)).toEqual([]);
});
