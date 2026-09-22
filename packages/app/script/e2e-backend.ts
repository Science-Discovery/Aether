import { rmSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoDir = path.resolve(appDir, "../..")
const opencodeDir = path.join(repoDir, "packages", "opencode")

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port <= 0) {
  console.error(`e2e-backend: expected a port argument, got "${process.argv[2]}"`)
  process.exit(1)
}

const staleMs = 24 * 3600_000

const sweep = async () => {
  const names = await fs.readdir(os.tmpdir()).catch(() => [])
  await Promise.allSettled(
    names
      .filter((name) => name.startsWith("opencode-e2e-server-"))
      .map(async (name) => {
        const dir = path.join(os.tmpdir(), name)
        const stat = await fs.stat(dir).catch(() => undefined)
        if (!stat?.mtime || Date.now() - stat.mtimeMs < staleMs) return
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }),
  )
}

await sweep()

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-e2e-server-"))

Object.assign(process.env, {
  OPENCODE_DISABLE_SHARE: process.env.OPENCODE_DISABLE_SHARE ?? "true",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  OPENCODE_TEST_HOME: path.join(sandbox, "home"),
  XDG_DATA_HOME: path.join(sandbox, "share"),
  XDG_CACHE_HOME: path.join(sandbox, "cache"),
  XDG_CONFIG_HOME: path.join(sandbox, "config"),
  XDG_STATE_HOME: path.join(sandbox, "state"),
  OPENCODE_MODELS_PATH: path.join(opencodeDir, "test", "tool", "fixtures", "models-api.json"),
  ANTHROPIC_API_KEY: "",
  OPENCODE_CLIENT: "app",
  OPENCODE_STRICT_CONFIG_DEPS: "true",
  OPENCODE_SERVER_USERNAME: "",
  OPENCODE_SERVER_PASSWORD: "",
  AGENT: "1",
  OPENCODE: "1",
  OPENCODE_PID: String(process.pid),
} satisfies Record<string, string>)

const log = await import("../../opencode/src/util/log")
const install = await import("../../opencode/src/installation")
await log.Log.init({
  print: true,
  dev: install.Installation.isLocal(),
  level: "WARN",
})

const servermod = await import("../../opencode/src/server/server")
await servermod.Server.listen({ port, hostname: "127.0.0.1" })
console.log(`opencode server listening on http://127.0.0.1:${port}`)

process.on("exit", () => {
  rmSync(sandbox, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 10 : 3,
    retryDelay: process.platform === "win32" ? 500 : 100,
  })
})
