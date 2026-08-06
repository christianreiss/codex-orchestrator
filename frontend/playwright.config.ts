import { defineConfig } from "@playwright/test";

/**
 * Two apps, two servers. The admin console is the SvelteKit app under /admin;
 * the agent portal is a separate Vite build served at /go by the API, so it
 * needs its own dev server rather than a route inside the first one. Without
 * the second project the portal -- the only surface a non-admin ever touches --
 * had no browser coverage at all.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "admin",
      testMatch: /admin-.*\.spec\.ts/,
      use: { baseURL: "http://127.0.0.1:4173" },
    },
    {
      name: "portal",
      testMatch: /portal-.*\.spec\.ts/,
      use: { baseURL: "http://127.0.0.1:4174" },
    },
  ],
  webServer: [
    {
      command: "npm run dev -- --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173/admin/dashboard",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npx vite --config vite.portal.config.ts --host 127.0.0.1 --port 4174",
      url: "http://127.0.0.1:4174/go/",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
