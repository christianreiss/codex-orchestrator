import { expect, test } from "@playwright/test";
import { fixture, installFixtures } from "./admin-fixtures";

for (const width of [320, 1440]) {
  test(`chat file pickers have visible focus and touch targets at ${width}px`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width, height: 900 }, hasTouch: true });
    const page = await context.newPage();
    await installFixtures(page, (path) => {
      if (path !== "/admin/agent-sessions") return undefined;
      const data = structuredClone(fixture(path));
      const sessions = data.sessions as Record<string, unknown>[];
      const now = new Date().toISOString();
      data.generated_at = now;
      Object.assign(sessions[0], { presence: "listening", relay_ready: true, relay_enabled: true, relay_heartbeat_at: now });
      return data;
    });
    await page.goto("/admin/agents?session=11111111-1111-4111-8111-111111111111");
    for (const name of ["Attach files", "Photo"]) {
      const input = page.getByLabel(name, { exact: true });
      const label = input.locator("..");
      await expect(input).toBeEnabled();
      const bounds = await label.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      const unfocusedShadow = await label.evaluate((element) => getComputedStyle(element).boxShadow);
      await input.focus();
      await expect(input).toBeFocused();
      const focusedShadow = await label.evaluate((element) => getComputedStyle(element).boxShadow);
      expect(focusedShadow).not.toBe(unfocusedShadow);
      expect(focusedShadow).not.toBe("none");
      const chooser = page.waitForEvent("filechooser");
      await input.press("Enter");
      await (await chooser).setFiles([]);
    }
    await context.close();
  });
}

for (const width of [320, 1440]) {
  test(`message filters explain their current values before opening at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installFixtures(page);
    await page.goto("/admin/agent-messaging");
    const conversation = page.getByRole("button", { name: "Conversation status", exact: true });
    await expect(page.getByText("Conversation status", { exact: true })).toBeVisible();
    await expect(conversation).toHaveText("All conversations");
    await expect(page.getByText("Result limit", { exact: true })).toBeVisible();
    await conversation.click();
    await page.getByRole("option", { name: "Open", exact: true }).click();
    await expect(conversation).toHaveText("Open");
    await page.getByRole("button", { name: "Delivery log", exact: true }).click();
    const delivery = page.getByRole("button", { name: "Delivery status", exact: true });
    await expect(delivery).toHaveText("All deliveries");
    await expect(page.getByText("Delivery status", { exact: true })).toBeVisible();
    await delivery.click();
    await page.getByRole("option", { name: "queued", exact: true }).click();
    await expect(delivery).toHaveText("Queued");
    const limit = page.getByRole("button", { name: "Result limit", exact: true });
    await limit.click();
    await page.getByRole("option", { name: "250", exact: true }).click();
    await expect(limit).toHaveText("250");
    await expect(page).toHaveURL(/message_status=queued/);
    await expect(page).toHaveURL(/limit=250/);
    await page.reload();
    await expect(delivery).toHaveText("Queued");
    await expect(limit).toHaveText("250");
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await expect(conversation).toHaveText("Open");
    await page.getByRole("button", { name: "Addresses", exact: true }).click();
    await expect(conversation).toHaveCount(0);
    await expect(limit).toHaveText("250");
    await page.getByRole("button", { name: "Groups", exact: true }).click();
    await expect(limit).toHaveCount(0);
  });

  test(`board dates retain their label and reading order at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installFixtures(page, (path) => {
      if (path !== "/admin/projects/fleet-console/board") return undefined;
      const board = structuredClone(fixture(path));
      const columns = board.columns as { cards: Record<string, unknown>[] }[];
      columns[1].cards[0].due_at = "2099-01-01T00:00:00Z";
      return board;
    });
    await page.goto("/admin/projects/fleet-console/board");
    const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Capture baseline", exact: true }) });
    await card.scrollIntoViewIfNeeded();
    const claim = card.getByText(/^code · chris on crane\.example · expires/);
    await expect(claim).toBeVisible();

    // A flex item for the date can put its first line above the preceding
    // "expires" label. Check rendered reading order, including wrapped badges.
    const expiryOrder = await claim.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text: Node | null;
      while ((text = walker.nextNode())) {
        const offset = text.textContent?.indexOf("expires") ?? -1;
        if (offset < 0) continue;
        const label = document.createRange();
        label.setStart(text, offset);
        label.setEnd(text, offset + "expires".length);
        const date = element.querySelector("time")!;
        return { labelTop: label.getBoundingClientRect().top, dateTop: date.getClientRects()[0].top };
      }
      throw new Error("Claim expiry label was not rendered");
    });
    expect(expiryOrder.dateTop).toBeGreaterThanOrEqual(expiryOrder.labelTop - 1);

    const due = card.getByText(/^due /);
    const dueSpacing = await due.evaluate((element) => {
      const label = document.createRange();
      label.setStart(element.firstChild!, 0);
      label.setEnd(element.firstChild!, 3);
      const labelBounds = label.getBoundingClientRect();
      const dateBounds = element.querySelector("time")!.getClientRects()[0];
      return { sameLine: Math.abs(labelBounds.top - dateBounds.top) < 1, gap: dateBounds.left - labelBounds.right };
    });
    expect(dueSpacing.sameLine).toBe(true);
    expect(dueSpacing.gap).toBeGreaterThan(1);
  });
}
