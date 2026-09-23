import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../fixtures"
import { freePort } from "../port"
import { createSdk, dirSlug } from "../utils"

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const repoDir = path.resolve(appDir, "../..")
const opencodeDir = path.join(repoDir, "packages", "opencode")

async function waitHealth(url: string, errors: string[] = []) {
  const end = Date.now() + 120_000
  while (Date.now() < end) {
    try {
      const res = await fetch(`${url}/global/health`)
      if (res.ok) return
    } catch {
      // backend not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for backend health at ${url}\n${errors.slice(-20).join("")}`)
}

function spawnBackend(port: number, sandbox: string, errors: string[]) {
  const proc = spawn(
    "bun",
    ["run", "--conditions=browser", "./src/index.ts", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: opencodeDir,
      env: {
        ...process.env,
        OPENCODE_DISABLE_SHARE: "true",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        OPENCODE_TEST_HOME: path.join(sandbox, "home"),
        XDG_DATA_HOME: path.join(sandbox, "share"),
        XDG_CACHE_HOME: path.join(sandbox, "cache"),
        XDG_CONFIG_HOME: path.join(sandbox, "config"),
        XDG_STATE_HOME: path.join(sandbox, "state"),
        // Windows persists app state under APPDATA; without redirecting it, an
        // enabled mobile bridge on the host leaks into the e2e backend and kills it.
        ...(process.platform === "win32" ? { APPDATA: path.join(sandbox, "appdata") } : {}),
        OPENCODE_MODELS_PATH: path.join(opencodeDir, "test", "tool", "fixtures", "models-api.json"),
        ANTHROPIC_API_KEY: "",
        OPENCODE_CLIENT: "app",
        OPENCODE_STRICT_CONFIG_DEPS: "true",
        OPENCODE_SERVER_USERNAME: "",
        OPENCODE_SERVER_PASSWORD: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  proc.stderr?.on("data", (chunk) => {
    errors.push(String(chunk))
    if (errors.length > 200) errors.splice(0, errors.length - 200)
  })
  proc.on("error", (err) => errors.push(`spawn error: ${err}\n`))
  proc.once("exit", (code, signal) => errors.push(`backend exited: code=${code} signal=${signal}\n`))
  return proc
}

async function killBackend(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill("SIGKILL")
  await new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    proc.once("exit", () => resolve())
  })
}

test.setTimeout(240_000)

test("message written during a hard event-stream outage is recovered after reconnect", async ({ page }) => {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-e2e-sse-"))
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-e2e-sse-project-"))
  const errs: string[] = []
  let proc = spawnBackend(port, sandbox, errs)
  await waitHealth(url, errs)

  const seed = `e2e reconnect seed ${Date.now()}`
  const lost = `e2e reconnect lost ${Date.now()}`

  try {
    const sdk = createSdk(worktree, url)
    const session = await sdk.session.create({ directory: worktree, title: "e2e sse reconnect" }).then((r) => r.data)
    if (!session?.id) throw new Error("Session create did not return an id")
    await sdk.session.promptAsync({
      sessionID: session.id,
      noReply: true,
      parts: [{ type: "text", text: seed }],
    })

    await page.addInitScript(
      (args: { url: string; directory: string }) => {
        const store = { list: [args.url], projects: {}, lastProject: {} }
        store.projects.local = [{ worktree: args.directory, expanded: true }]
        store.projects[args.url] = [{ worktree: args.directory, expanded: true }]
        localStorage.setItem("opencode.global.dat:server", JSON.stringify(store))
        localStorage.setItem("opencode.settings.dat:defaultServerUrl", args.url)
        localStorage.setItem(
          "opencode.global.dat:model",
          JSON.stringify({
            recent: [{ providerID: "opencode", modelID: "big-pickle" }],
            user: [],
            variant: {},
          }),
        )
      },
      { url, directory: worktree },
    )

    await page.goto(`/${dirSlug(worktree)}/session/${session.id}`)
    await expect(page.locator("[data-slot='user-message-text']").filter({ hasText: seed })).toBeVisible({
      timeout: 60_000,
    })

    // Hard-kill the backend so the SSE socket dies for real, then block every
    // reconnect attempt at the browser so a replacement backend can serve data
    // the client provably cannot see.
    await killBackend(proc)
    await page.context().route("**/global/event**", (route) => route.abort())

    proc = spawnBackend(port, sandbox, errs)
    await waitHealth(url, errs)
    const restarted = createSdk(worktree, url)
    await restarted.session.promptAsync({
      sessionID: session.id,
      noReply: true,
      parts: [{ type: "text", text: lost }],
    })
    await expect
      .poll(
        async () => {
          const messages = await restarted.session
            .messages({ sessionID: session.id, limit: 20 })
            .then((r) => r.data ?? [])
          return messages.some((message) => message.parts.some((part) => part.type === "text" && part.text === lost))
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    await page.context().unroute("**/global/event**")
    await expect(page.locator("[data-slot='user-message-text']").filter({ hasText: lost })).toBeVisible({
      timeout: 30_000,
    })
  } finally {
    await killBackend(proc)
    await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined)
  }
})
