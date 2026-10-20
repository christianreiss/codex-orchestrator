import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** Separate command so a Chromium-only developer install still runs the canonical suite. */
export default defineConfig({
  ...base,
  projects: ["firefox", "webkit"].map((browserName) => ({
    name: browserName,
    testMatch: /admin-(?:design|workflows|room-chats|agent-messaging)\.spec\.ts/,
    use: { baseURL: `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT ?? 4173)}`, browserName: browserName as "firefox" | "webkit" },
  })),
});
