// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { execFileSync } from "child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll } from "bun:test"

// Set XDG env vars FIRST, before any src/ imports
const dir = path.join(os.tmpdir(), "aether-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(async () => {
  const { Database } = await import("../src/storage/db")
  Database.close()
  const busy = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await sleep(100)
    return fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      if (!busy(error)) throw error
      if (left <= 1) throw error
      return rm(left - 1)
    })
  }

  // Windows can keep SQLite WAL handles alive until GC finalizers run, so we
  // force GC and retry teardown to avoid flaky EBUSY in test cleanup.
  await rm(30)
})

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["OPENCODE_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")

// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["OPENCODE_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir
process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"

const rg = process.env.OPENCODE_RIPGREP_PATH || (() => {
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which"
    const out = execFileSync(cmd, ["rg"], { encoding: "utf8" })
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
})()

if (rg) process.env["OPENCODE_RIPGREP_PATH"] = rg

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "aether")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "21")

// Clear provider and server auth env vars to ensure clean unit-test state.
// System tests (OPENCODE_SYSTEM_TEST=1) need real keys, so skip deletion.
if (process.env.OPENCODE_SYSTEM_TEST !== "1") {
  delete process.env["ANTHROPIC_API_KEY"]
  delete process.env["OPENAI_API_KEY"]
  delete process.env["GOOGLE_API_KEY"]
  delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
  delete process.env["AZURE_OPENAI_API_KEY"]
  delete process.env["AWS_ACCESS_KEY_ID"]
  delete process.env["AWS_PROFILE"]
  delete process.env["AWS_REGION"]
  delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
  delete process.env["OPENROUTER_API_KEY"]
  delete process.env["GROQ_API_KEY"]
  delete process.env["MISTRAL_API_KEY"]
  delete process.env["PERPLEXITY_API_KEY"]
  delete process.env["TOGETHER_API_KEY"]
  delete process.env["XAI_API_KEY"]
  delete process.env["DEEPSEEK_API_KEY"]
  delete process.env["FIREWORKS_API_KEY"]
  delete process.env["CEREBRAS_API_KEY"]
  delete process.env["SAMBANOVA_API_KEY"]
  delete process.env["OPENCODE_SERVER_PASSWORD"]
  delete process.env["OPENCODE_SERVER_USERNAME"]
}

// Use in-memory sqlite
process.env["OPENCODE_DB"] = ":memory:"

// Now safe to import from src/
const { Global } = await import("../src/global")
const { Log } = await import("../src/util/log")
const { initProjectors } = await import("../src/server/projectors")

await Global.ensureDirs()

Log.init({
  print: false,
  level: "DEBUG",
})

initProjectors()
