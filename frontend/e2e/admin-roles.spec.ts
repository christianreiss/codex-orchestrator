import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

const stamp = "2026-10-19T09:00:00Z";
const proposalId = "00000000-0000-4000-8000-0000000000a1";
const MANIFEST = "---\nname: design\nlabel: Designer\nsummary: Design reviews\n---\n\n# Rolle: Designagent\n\nDu übernimmst die gestalterische Verantwortung.\n";

async function fixture(page: Page, initiallyEnabled = false) {
  let enabled = initiallyEnabled;
  const policy = { mutation: "autonomous", protected_paths: [], daily_budget: 10, holder_upgrade: "at_task_boundary", verdict_binding: false };
  const v1 = { id: "v1", version: 1, state: "published", sha256: "a".repeat(64), changelog: "first", published_at: stamp, withdrawn_at: null, source_proposal_id: null, reverted_from_version: null, created_by: { kind: "admin" }, published_by: { kind: "admin" }, uri: "role://design@1" };
  let draft: Record<string, unknown> | null = { ...v1, id: "draft", version: null, state: "draft", manifest: MANIFEST, files: [{ path: "checklists/review.md", mime_type: "text/markdown", load: "core", description: "Review checklist", size_bytes: 24, sha256: "b".repeat(64), introduced_in_version: 1, source_proposal_id: null, uri: "role://design/checklists/review.md" }] };
  const detail = () => ({
    role: { slug: "design", display_name: "Design agent", summary: "Designs and reviews UI", status: "active", policy, version: 1, current_version_id: "v1" },
    versions: [v1],
    draft,
    holders: [{ address_id: "663c4cf2-f0c8-49a0-aac1-3059c9ee427c", version_id: "v1", activated_at: stamp, activated_by: { kind: "operator_prompt" }, reason: "Du bist der Design-Agent" }],
  });
  const proposal = {
    id: proposalId, role: "design", kind: "file_add", risk: "additive", title: "Add focus checklist", rationale: "Missed twice in reviews", evidence: [], status: "held", version: 3,
    author: { address_id: "3061d0c7-fab3-4810-953b-7528a92c6c54", engine: "codex", role_version: 1 }, ops: [{ op: "put", path: "checklists/focus.md", size_bytes: 30, load: "on_demand" }],
    gate_results: { passed: true, checks: [{ gate: "base_current", ok: true }, { gate: "no_secrets", ok: true }] }, judge: { verdict: "accept", reason: "adds checklists/focus.md", model: "judge" },
    reviews: [], decision_note: "daily budget of 10 versions reached", result_version_id: null, created_at: stamp, updated_at: stamp,
  };
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/admin/**", async (route) => {
    const req = route.request();
    if (req.resourceType() === "document" || !req.headers().accept?.includes("application/json")) return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (path === "/admin/auth/status") return json({ authenticated: true, enforced: true, user: { id: 1, username: "operator", roles: ["owner"] }, capabilities: ["admin.read", "content.read", "content.manage"] });
    if (path === "/admin/setup/status") return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: stamp, dismissed_at: null } });
    if (path === "/admin/ws/info") return json({ enabled: false });
    if (req.method() !== "GET") {
      const body = req.postData() ? req.postDataJSON() : null;
      writes.push({ method: req.method(), path, body });
      if (path === "/admin/roles/state") { enabled = body.enabled; return json({ enabled }); }
      if (path === "/admin/roles/design/draft" && req.method() === "PUT") { draft = { ...(draft ?? {}), manifest: body.manifest }; return json(detail()); }
      if (path === "/admin/roles/design/publish") { draft = null; return json({ ...detail(), versions: [{ ...v1, id: "v2", version: 2 }, v1], role: { ...detail().role, current_version_id: "v2" } }); }
      if (path === `/admin/roles/proposals/${proposalId}/decide`) return json({ proposal: { ...proposal, status: "applied" } });
      return json({});
    }
    if (path === "/admin/roles") return json({ enabled, roles: [{ slug: "design", display_name: "Design agent", summary: "Designs and reviews UI", status: "active", current_version: 1, policy, holders: 1, open_proposals: 1, held_proposals: 1, updated_at: stamp }] });
    if (path === "/admin/roles/state") return json({ enabled });
    if (path === "/admin/roles/design") return json(detail());
    if (path === "/admin/roles/design/timeline") return json({ role: "design", versions: [v1], proposals: [proposal] });
    if (path === `/admin/roles/proposals/${proposalId}`) return json({ proposal, current: [{ path: "checklists/focus.md", text: null }], proposed: [{ path: "checklists/focus.md", text: "- visible focus on every control\n", binary: false }], events: [{ seq: 1, action: "proposed", actor: { kind: "agent", address_id: proposal.author.address_id }, detail: {}, at: stamp }] });
    return json({});
  });
  return writes;
}

test("roles are off until the operator turns them on, and the list says what is held", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto("/admin/library?type=roles");
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Agent roles are off" })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Agent roles" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(writes[0]).toEqual({ method: "POST", path: "/admin/roles/state", body: { enabled: true } });
  await expect(page.getByRole("status").filter({ hasText: "Agent roles are off" })).toHaveCount(0);
  const row = page.getByRole("row", { name: /Design agent/ });
  await expect(row).toContainText("v1");
  await expect(row).toContainText("1 held for you");
  const axe = await new AxeBuilder({ page }).include("main").analyze();
  expect(axe.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`)).toEqual([]);
});

test("the operator edits and publishes a draft, then steers a held proposal", async ({ page }) => {
  const writes = await fixture(page, true);
  await page.goto("/admin/library/roles/design");
  await expect(page.getByRole("heading", { level: 1, name: "Design agent" })).toBeVisible();
  const editor = page.getByLabel("Role manifest (ROLE.md)");
  await expect(editor).toHaveValue(/Rolle: Designagent/);
  await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();
  await editor.fill(`${MANIFEST}\nZweite Fassung.\n`);
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(() => writes.find((w) => w.method === "PUT")?.body).toMatchObject({ manifest: expect.stringContaining("Zweite Fassung."), files: [{ path: "checklists/review.md", blob_sha256: "b".repeat(64), load: "core" }] });
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByLabel("Changelog").fill("Second pass");
  await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
  await expect.poll(() => writes.find((w) => w.path === "/admin/roles/design/publish")?.body).toEqual({ changelog: "Second pass" });

  await page.getByRole("button", { name: "Add focus checklist" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("- visible focus on every control")).toBeVisible();
  await expect(sheet.getByText("(not present)")).toBeVisible();
  await sheet.getByRole("button", { name: "Publish now" }).click();
  await expect(sheet.getByText("Say why")).toBeVisible();
  await sheet.getByLabel("Reason").fill("Budget hit by a burst; this one is fine");
  await sheet.getByRole("button", { name: "Publish now" }).click();
  await expect.poll(() => writes.find((w) => w.path.endsWith("/decide"))?.body).toEqual({ verdict: "accept", reason: "Budget hit by a burst; this one is fine", expected_version: 3 });
});

test("the role editor reflows at phone width", async ({ page }) => {
  await fixture(page, true);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/admin/library/roles/design");
  await expect(page.getByRole("heading", { level: 1, name: "Design agent" })).toBeVisible();
  const overflow = await page.locator("main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
  const axe = await new AxeBuilder({ page }).include("main").analyze();
  expect(axe.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`)).toEqual([]);
});
