import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { freePort } from "./port"
import { claim, create, remove, sweep } from "./sandbox"

type Handle = {
  url: string
  run: string
  stop: () => Promise<void>
}

async function waitForHealth(url: string, proc: ReturnType<typeof spawn>, probe = "/global/health") {
  const end = Date.now() + 120_000
  let last = ""
  while (Date.now() < end) {
    if (done(proc)) {
      throw new Error(`backend exited with code ${proc.exitCode ?? "signal " + proc.signalCode}`)
    }
    try {
      const res = await fetch(`${url}${probe}`)
      if (res.ok) return
      last = `status ${res.status}`
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for backend health at ${url}${probe}${last ? ` (${last})` : ""}`)
}

function done(proc: ReturnType<typeof spawn>) {
  return proc.exitCode !== null || proc.signalCode !== null
}

async function waitExit(proc: ReturnType<typeof spawn>, timeout = 10_000) {
  if (done(proc)) return
  await Promise.race([
    new Promise<void>((resolve) => proc.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeout)),
  ])
}

const cap = 100

function trim(input: string[]) {
  if (input.length > cap) input.splice(0, input.length - cap)
}

function tail(input: string[]) {
  return input.slice(-40).join("")
}

export async function startBackend(label: string, input?: { llmUrl?: string }): Promise<Handle> {
  await sweep()
  try {
    return await launch(label, input)
  } catch (first) {
    console.warn(`[e2e] backend start failed for ${label}, retrying once`, first)
    return await launch(label, input)
  }
}

async function launch(label: string, input?: { llmUrl?: string }): Promise<Handle> {
  const port = await freePort()
  const run = randomUUID()
  const sandbox = await create(label)
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const repoDir = path.resolve(appDir, "../..")
  const opencodeDir = path.join(repoDir, "packages", "opencode")
  const env = {
    ...process.env,
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_MOBILE: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    OPENCODE_TEST_HOME: path.join(sandbox, "home"),
    XDG_DATA_HOME: path.join(sandbox, "share"),
    XDG_CACHE_HOME: path.join(sandbox, "cache"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    XDG_STATE_HOME: path.join(sandbox, "state"),
    OPENCODE_CLIENT: "app",
    OPENCODE_STRICT_CONFIG_DEPS: "true",
    OPENCODE_SERVER_USERNAME: "",
    OPENCODE_SERVER_PASSWORD: "",
    OPENCODE_E2E_RUN_ID: run,
    OPENCODE_E2E_LLM_URL: input?.llmUrl,
  } satisfies Record<string, string | undefined>
  const out: string[] = []
  const err: string[] = []
  const proc = spawn(
    "bun",
    ["run", "--conditions=browser", "./src/index.ts", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: opencodeDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  proc.stdout?.on("data", (chunk) => {
    out.push(String(chunk))
    trim(out)
  })
  proc.stderr?.on("data", (chunk) => {
    err.push(String(chunk))
    trim(err)
  })
  await claim(sandbox, proc.pid)

  const url = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(url, proc, `/global/health?run=${run}`)
  } catch (error) {
    proc.kill("SIGTERM")
    await waitExit(proc)
    if (!done(proc)) {
      proc.kill("SIGKILL")
      await waitExit(proc)
    }
    await remove(sandbox)
    throw new Error(
      [
        `Failed to start isolated e2e backend for ${label}`,
        error instanceof Error ? error.message : String(error),
        tail(out),
        tail(err),
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  return {
    url,
    run,
    async stop() {
      if (!done(proc)) {
        proc.kill("SIGTERM")
        await waitExit(proc)
      }
      if (!done(proc)) {
        proc.kill("SIGKILL")
        await waitExit(proc)
      }
      if (!done(proc)) {
        console.warn(`[e2e] backend ${label} (pid ${proc.pid}) did not exit; sandbox ${sandbox} left for sweep`)
        return
      }
      await remove(sandbox)
    },
  }
}
