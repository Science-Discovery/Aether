import { defineConfig, devices, type ReporterDescription } from "@playwright/test"
import { freePort } from "./e2e/port"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 0) || (await freePort())
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
const remoteServer = Boolean(process.env.PLAYWRIGHT_SERVER_PORT || process.env.PLAYWRIGHT_SERVER_HOST)
const serverPort =
  process.env.PLAYWRIGHT_SERVER_PORT ?? (process.env.PLAYWRIGHT_SERVER_HOST ? "4096" : String(await freePort()))
process.env.PLAYWRIGHT_SERVER_PORT = serverPort
const command = `bun run dev -- --host 0.0.0.0 --port ${port}`
const reuse = !process.env.CI
const workers = Number(process.env.PLAYWRIGHT_WORKERS ?? (process.env.CI ? 5 : 0)) || undefined
const reporter: ReporterDescription[] = [["html", { outputFolder: "e2e/playwright-report", open: "never" }], ["line"]]

if (process.env.PLAYWRIGHT_JUNIT_OUTPUT) {
  reporter.push(["junit", { outputFile: process.env.PLAYWRIGHT_JUNIT_OUTPUT }])
}

const webServer = [
  {
    command,
    url: baseURL,
    reuseExistingServer: reuse,
    timeout: 120_000,
    env: {
      VITE_OPENCODE_SERVER_HOST: serverHost,
      VITE_OPENCODE_SERVER_PORT: serverPort,
    },
  },
  ...(remoteServer
    ? []
    : [
        {
          command: "bun script/e2e-backend.ts",
          url: `http://127.0.0.1:${serverPort}/global/health`,
          timeout: 120_000,
        },
      ]),
]

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "./e2e/test-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: process.env.PLAYWRIGHT_FULLY_PARALLEL === "1",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter,
  webServer,
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
