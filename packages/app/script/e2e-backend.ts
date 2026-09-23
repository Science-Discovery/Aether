import { rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { create, rmOpts, sweep } from "../e2e/sandbox"

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoDir = path.resolve(appDir, "../..")
const opencodeDir = path.join(repoDir, "packages", "opencode")

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port <= 0) {
  console.error(`e2e-backend: expected a port argument, got "${process.argv[2]}"`)
  process.exit(1)
}

const run = process.argv[3]
if (run) process.env.OPENCODE_E2E_RUN_ID = run

await sweep()

const sandbox = await create("server", process.pid)

Object.assign(process.env, {
  OPENCODE_DISABLE_SHARE: process.env.OPENCODE_DISABLE_SHARE ?? "true",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_MOBILE: "true",
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
  try {
    rmSync(sandbox, rmOpts)
  } catch (err) {
    console.error(`[e2e-backend] failed to remove sandbox ${sandbox}: ${err}`)
  }
})
