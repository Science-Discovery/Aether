import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"

const dir = process.argv[2]!
process.env["OPENCODE_TEST_HOME"] = path.join(dir, "home")
process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = path.join(dir, "managed")
process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"
process.env["OPENCODE_MODELS_PATH"] = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
process.env["XDG_DATA_HOME"] = path.join(dir, "data")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
await fs.mkdir(path.join(dir, "home"), { recursive: true })
await Bun.write(path.join(dir, "style.css"), "body{color:blue}")

const { Server } = await import("../../src/server/server")
const { Instance } = await import("../../src/project/instance")
const { Database } = await import("../../src/storage/db")
await Instance.provide({ directory: dir, fn: () => {} })
const app = Server.Default()
const request = (auth?: string) =>
  app.request("/file/preview/resource?path=style.css", {
    headers: { "x-opencode-directory": dir, ...(auth ? { Authorization: auth } : {}) },
  })
const denied = await request()
assert.equal(denied.status, 401)
assert.equal((await request("Basic " + btoa("opencode:wrong"))).status, 401)
const allowed = await request("Basic " + btoa("opencode:preview-test-password"))
assert.equal(allowed.status, 200)
assert.equal(await allowed.text(), "body{color:blue}")
await Instance.disposeAll()
Database.close()
console.log("preview authentication passed")
