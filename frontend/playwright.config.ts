import { defineConfig } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);

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
      use: { baseURL: `http://127.0.0.1:${port}` },
    },
  ],
  webServer: [
    {
      // Exercise the deployable SPA and wait for the build before opening a
      // browser. Dev-server cold compilation can outlast locator deadlines.
      command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
      url: `http://127.0.0.1:${port}/admin/dashboard`,
      // A server from another worktree must never satisfy this checkout's gate.
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
