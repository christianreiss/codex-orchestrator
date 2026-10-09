import { test, expect } from "@playwright/test";
test("daemon indicators are separate, enabled-only, and update live", async ({
  page,
}) => {
  let emit: (s: string) => void = () => {};
  await page.routeWebSocket("**/daemon-test-ws", (ws) => {
    emit = (s) => ws.send(s);
  });
  const stamp = () => new Date().toISOString();
  const hosts = [1, 2, 3, 4].map((id) => ({
    id,
    fqdn: `daemon-${id}.test`,
    status: "active",
    engines: "codex",
    secure: true,
    updated_at: stamp(),
    last_refresh: stamp(),
    users: [],
  }));
  const daemons = [1, 2, 3].map((id, i) => ({
    host_id: id,
    enabled: true,
    username: "root",
    health: {
      state: ["green", "yellow", "red"][i],
      reasons: i === 1 ? ["busy"] : i === 2 ? ["heartbeat_expired"] : [],
      heartbeat_at: stamp(),
      evaluated_at: stamp(),
      used_slots: i === 1 ? 8 : 0,
      max_slots: 8,
    },
    sessions: [],
  }));
  await page.route("**/admin/**", (route) => {
    const req = route.request();
    if (!req.headers().accept?.includes("application/json"))
      return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (data: unknown) =>
      route.fulfill({ json: { status: "ok", data } });
    if (path === "/admin/auth/status")
      return json({
        authenticated: true,
        enforced: true,
        user: { id: 1, username: "owner", roles: ["owner"] },
        capabilities: ["admin.read", "hosts.read", "settings.read"],
      });
    if (path === "/admin/setup/status")
      return json({
        setup_complete: true,
        critical_complete: true,
        checks: [],
        next_actions: [],
        wizard: { completed_at: stamp(), dismissed_at: null },
      });
    if (path === "/admin/ws/info")
      return json({ enabled: true, url: "ws://127.0.0.1:4173/daemon-test-ws" });
    if (path === "/admin/hosts") return json({ hosts });
    if (path === "/admin/host-daemons") return json({ hosts: daemons });
    if (path === "/admin/engines/state")
      return json({
        engines: ["codex", "claude", "grok"].map((engine) => ({
          engine,
          enabled: true,
        })),
      });
    if (path === "/admin/insecure-approvals/pending")
      return json({ requests: [] });
    return json({});
  });
  await page.goto("/admin/hosts");
  await expect(page.getByText("daemon-1.test", {exact:true}).first()).toBeVisible({timeout:20_000});
  await expect(
    page.locator('[data-daemon-state="green"]:visible').first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-daemon-state="yellow"]').first(),
  ).toHaveAttribute("aria-label", /8\/8 Slots/);
  await expect(
    page.locator('[data-daemon-state="red"]').first(),
  ).toHaveAttribute("aria-label", /nicht erreichbar/);
  const row = page
    .getByRole("button")
    .filter({ has: page.getByText("daemon-4.test", { exact: true }) });
  await expect(row.locator("[data-daemon-state]")).toHaveCount(0);
  daemons[0]!.health.state = "red";
  daemons[0]!.health.reasons = ["heartbeat_expired"];
  emit(
    JSON.stringify({
      type: "host.daemon.changed",
      payload: { host_id: 1 },
      ts: stamp(),
    }),
  );
  await expect(page.locator('[data-daemon-state="green"]')).toHaveCount(0);
});
