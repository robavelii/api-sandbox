import { defineConfig, devices } from "@playwright/test";

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  "postgresql://spectwin:local-test-only@127.0.0.1:55432/spectwin_e2e";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: "artifacts/playwright-results",
  reporter: [
    ["line"],
    ["junit", { outputFile: "artifacts/playwright-junit.xml" }],
    ["html", { outputFolder: "artifacts/playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node --import tsx tests/e2e/start-server.ts api",
      url: "http://127.0.0.1:4100/health",
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        DATABASE_URL: databaseUrl,
        PORT: "4100",
        HOST: "127.0.0.1",
        WEB_ORIGIN: "http://127.0.0.1:3100",
        NODE_ENV: "test",
      },
    },
    {
      command: "node --import tsx tests/e2e/start-server.ts web",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        API_URL: "http://127.0.0.1:4100",
        NEXT_PUBLIC_RUNTIME_URL: "http://127.0.0.1:4100",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
