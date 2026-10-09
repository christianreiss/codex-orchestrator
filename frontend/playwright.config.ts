import { defineConfig } from "@playwright/test";

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
  ],
  webServer: [
    {
      command: "npm run dev -- --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173/admin/dashboard",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
