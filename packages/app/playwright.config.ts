import { randomUUID } from "node:crypto"
import { defineConfig, devices, type ReporterDescription } from "@playwright/test"
import { freePort } from "./e2e/port"

const webGiven = process.env.PLAYWRIGHT_PORT
const port = Number(webGiven ?? 0) || Number(process.env.PLAYWRIGHT_PORT_RESOLVED ?? 0) || (await freePort())
process.env.PLAYWRIGHT_PORT_RESOLVED = String(port)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
const serverGiven = process.env.PLAYWRIGHT_SERVER_PORT
if (!serverGiven && process.env.PLAYWRIGHT_SERVER_HOST) {
  throw new Error(
    "PLAYWRIGHT_SERVER_HOST requires PLAYWRIGHT_SERVER_PORT: an implicit backend port would pin every parallel run to the same backend",
  )
}
const serverPort = serverGiven || process.env.PLAYWRIGHT_SERVER_PORT_RESOLVED || String(await freePort())
process.env.PLAYWRIGHT_SERVER_PORT_RESOLVED = serverPort
process.env.PLAYWRIGHT_SERVER_PORT = serverPort
const remoteServer = Boolean(serverGiven || process.env.PLAYWRIGHT_SERVER_HOST)
const run = randomUUID()
const command = `bun run dev -- --host 0.0.0.0 --port ${port}`
const reuse = !process.env.CI && Boolean(webGiven)
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
          command: `bun script/e2e-backend.ts ${serverPort} ${run}`,
          url: `http://127.0.0.1:${serverPort}/global/health?run=${run}`,
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
