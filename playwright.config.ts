import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: /responsive\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        { command: "pnpm --filter @errata/runtime dev", url: "http://127.0.0.1:4000/api/v1/health", reuseExistingServer: true, timeout: 120_000, env: { ENABLE_TEST_HARNESS: "true" } },
        { command: "pnpm --filter @errata/web dev", url: "http://localhost:3000", reuseExistingServer: true, timeout: 120_000 },
      ],
});
