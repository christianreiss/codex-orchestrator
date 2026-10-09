import { test, expect } from "@playwright/test";

test("starts, resumes and stops remote work from the chat portal", async ({
  page,
}) => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const session = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Build helper",
    engine: "claude",
    status: "idle",
    sessionId: null,
    operations: [{ status: "completed", result: { reply: "Ready to help" } }],
  };
  const host = {
    host_id: 1,
    fqdn: "worker.test",
    enabled: true,
    default_cwd: "/srv/repo",
    health: { state: "green" },
    sessions: [],
  };
  await page.route("**/go/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (data: unknown) =>
      route.fulfill({ json: { status: "ok", data } });
    if (path.endsWith("/state"))
      return json({
        enabled: true,
        timings: {
          heartbeat_fresh_seconds: 45,
          relay_fresh_seconds: 60,
          retention_hours: 24,
        },
      });
    if (path.endsWith("/me"))
      return json({ user: { id: 1, display_name: "Operator" } });
    if (path.endsWith("/agents"))
      return json({ agents: [], generated_at: new Date().toISOString() });
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": idle\n\n",
      });
    if (path.endsWith("/host-daemons")) return json({ hosts: [host] });
    if (route.request().method() === "POST") {
      calls.push({ path, body: route.request().postDataJSON() });
      if (path.endsWith("/daemon-sessions"))
        return json({ session_id: session.id });
      if (path.endsWith("/stop")) session.status = "closed";
      return json({ session_id: session.id });
    }
    if (path.endsWith("/" + session.id)) return json(session);
    return json({});
  });
  await page.goto("/go/");
  await page
    .getByRole("button", { name: "Remote-Sessions", exact: true })
    .click();
  await page.getByText("Neue Remote-Session", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Engine", exact: true })
    .selectOption("claude");
  await page.getByLabel("Titel", { exact: true }).fill("Build helper");
  await page.getByLabel("Auftrag", { exact: true }).fill("Run the build");
  await page
    .getByRole("button", { name: "Session starten", exact: true })
    .click();
  await expect(page.getByText("Ready to help", { exact: true })).toBeVisible();
  expect(calls[0]!.body).toMatchObject({
    host_id: 1,
    engine: "claude",
    cwd: "/srv/repo",
    title: "Build helper",
    prompt: "Run the build",
  });
  expect(calls[0]!.body.client_message_id).toMatch(/^[0-9a-f-]{36}$/);
  await page
    .getByLabel("Nachricht / Fortsetzen", { exact: true })
    .fill("Continue");
  await page
    .getByRole("button", { name: "Senden / Fortsetzen", exact: true })
    .click();
  await expect
    .poll(() => calls.filter((c) => c.path.endsWith("/messages")).length)
    .toBe(1);
  await page.getByRole("button", { name: "Beenden", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Build helper · closed" }),
  ).toBeVisible();
});
