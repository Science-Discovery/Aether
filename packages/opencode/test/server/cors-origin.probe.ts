import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const out = process.env.AETHER_PROBE_OUT
if (!out) throw new Error("AETHER_PROBE_OUT is required")
const password = process.env.AETHER_PROBE_PASSWORD ?? "probe-secret"

const root = path.join(os.tmpdir(), "aether-cors-probe-data-" + Math.random().toString(36).slice(2))
const home = path.join(root, "home")
const cache = path.join(root, "cache", "aether")
for (const dir of [root, cache, home]) await fs.mkdir(dir, { recursive: true })
await Bun.write(path.join(cache, "version"), "21")
process.env.XDG_DATA_HOME = path.join(root, "share")
process.env.XDG_CACHE_HOME = path.join(root, "cache")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_STATE_HOME = path.join(root, "state")
process.env.OPENCODE_TEST_HOME = home
process.env.OPENCODE_DB = ":memory:"
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true"
process.env.OPENCODE_SERVER_PASSWORD = password

const { Log } = await import("../../src/util/log")
Log.init({ print: false, dev: true, level: "ERROR" })

const { Server } = await import("../../src/server/server")
const { Instance } = await import("../../src/project/instance")

const app = Server.createApp({})
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const results: Record<string, { status: number; acao: string | null }> = {}
const probe = async (name: string, target: string, init?: RequestInit) => {
  const res = await app.request(target, init)
  results[name] = {
    status: res.status,
    acao: res.headers.get("access-control-allow-origin"),
  }
  await res.text()
}

await probe("preflight.null", "/global/health", {
  method: "OPTIONS",
  headers: {
    origin: "null",
    "access-control-request-method": "GET",
    "access-control-request-headers": "authorization, range",
  },
})
await probe("health.null.noauth", "/global/health", { headers: { origin: "null" } })
await probe("health.null.auth", "/global/health", { headers: { origin: "null", authorization: auth } })
await probe("health.null.badauth", "/global/health", {
  headers: { origin: "null", authorization: "Basic b3BlbmNvZGU6d3Jvbmc=" },
})

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aether-cors-probe-"))
await Bun.write(path.join(dir, "file.txt"), "hello")
await Instance.provide({ directory: dir, fn: () => {} })
const query = `path=${encodeURIComponent("file.txt")}`
await probe("raw.null.noauth", `/file/raw?${query}`, {
  headers: { origin: "null", "x-opencode-directory": dir },
})
await probe("raw.null.auth", `/file/raw?${query}`, {
  headers: { origin: "null", "x-opencode-directory": dir, authorization: auth },
})
await Instance.disposeAll().catch(() => undefined)
await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)

await Bun.write(out, JSON.stringify(results))
process.exit(0)
