import { test, expect, type Page } from "@playwright/test";

const stamp = "2026-10-19T09:00:00Z";
const caps = { read: true, create: true, update: true, delete: true, append: true };

async function fixture(page: Page) {
  let memory = {
    node_id: "memory:shared:7", id: "deploy.notes", record_id: 7, scope: "shared", title: "Deploy notes", summary: "How we deploy",
    content: "second body", metadata: null, tags: ["deploy"], content_length: 11, host_id: null, host: null, project_id: null, project_slug: null,
    source_host_id: 32, engine: "claude", revision: 2, created_at: stamp, updated_at: stamp, etag: "etag-2", capabilities: caps,
  };
  const writes: Array<{ path: string; body: unknown }> = [];
  await page.route("**/admin/**", async (route) => {
    const req = route.request();
    if (req.resourceType() === "document" || !req.headers().accept?.includes("application/json")) return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (path === "/admin/auth/status") return json({ authenticated: true, enforced: true, user: { id: 1, username: "operator", roles: ["owner"] }, capabilities: ["admin.read", "content.read", "memory.read", "memory.write"] });
    if (path === "/admin/setup/status") return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: stamp, dismissed_at: null } });
    if (path === "/admin/ws/info") return json({ enabled: false });
    if (path === "/admin/memories/shared/7/restore") {
      const body = req.postDataJSON();
      writes.push({ path, body });
      memory = { ...memory, content: "first body", revision: 3, etag: "etag-3" };
      return json({ status: "restored", memory, restored_from_revision: body.revision });
    }
    if (path === "/admin/memories/graph") {
      const node = { id: memory.node_id, node_id: memory.node_id, memory_id: memory.id, key: memory.id, kind: "memory", label: memory.title, record_id: 7, scope: "shared", title: memory.title, summary: memory.summary, preview: memory.content, tags: memory.tags, content_length: memory.content_length, engine: "claude", revision: memory.revision, created_at: stamp, updated_at: stamp, capabilities: caps };
      return json({ status: "ok", nodes: [node], edges: [], facets: { scopes: [{ value: "shared", count: 1 }], hosts: [], projects: [], tags: [], engines: [] }, facets_truncated: { hosts: false, projects: false, tags: false }, totals: { all: 1, host: 0, project: 0, shared: 1 }, count: 1, next_cursor: null, truncated: false });
    }
    if (path === "/admin/memories/shared/7") return json({ status: "ok", memory });
    if (path === "/admin/memories/audit") {
      return json({
        status: "ok", node_id: memory.node_id, truncated: false, next_cursor: null,
        retention: { kind: "operational", immutable: false, body_history: false, note: "Metadata-only operational history." },
        activities: [
          { id: "shared_revision:2", source: "shared_revision", action: "write", actor_type: "host", admin_id: null, source_host_id: 32, source_engine: "claude", old_etag: null, new_etag: null, content_length: 11, delta_length: 0, tag_count: null, created_at: stamp, details: { revision: 2, restorable: true } },
          { id: "shared_revision:1", source: "shared_revision", action: "write", actor_type: "host", admin_id: null, source_host_id: 32, source_engine: "claude", old_etag: null, new_etag: null, content_length: 10, delta_length: 10, tag_count: null, created_at: stamp, details: { revision: 1, restorable: false } },
        ],
      });
    }
    return json({});
  });
  return writes;
}

test("an operator undoes one shared-memory replace from its activity", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto("/admin/library?type=memories");
  await page.getByRole("button", { name: /Inspect deploy\.notes/ }).first().click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("tab", { name: "Activity" }).click();
  const undo = sheet.getByRole("button", { name: "Undo this change" });
  await expect(undo).toHaveCount(1);
  await undo.click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Restore deploy\.notes/ })).getByRole("button", { name: "Restore text" }).click();
  await expect.poll(() => writes[0]).toEqual({ path: "/admin/memories/shared/7/restore", body: { revision: 2, expected_etag: "etag-2" } });
});
