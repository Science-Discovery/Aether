import fs from "fs/promises"
import os from "os"
import path from "path"
import { setTimeout as sleep } from "timers/promises"

const tmp = path.join(os.tmpdir(), `skill-watch-ensure-${Date.now()}`)
await fs.mkdir(tmp, { recursive: true })

process.env["XDG_DATA_HOME"] = path.join(tmp, "share")
process.env["XDG_CACHE_HOME"] = path.join(tmp, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(tmp, "config")
process.env["XDG_STATE_HOME"] = path.join(tmp, "state")
process.env["OPENCODE_TEST_HOME"] = path.join(tmp, "home")
process.env["OPENCODE_DB"] = ":memory:"
process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"

const cache = path.join(tmp, "cache", "aether")
await fs.mkdir(cache, { recursive: true })
await fs.writeFile(path.join(cache, "version"), "21")

const out: string[] = []
const prev = console.log.bind(console)
console.log = (...args: unknown[]) => {
  const line = args.map((item) => String(item)).join(" ")
  out.push(line)
  prev(...args)
}

const { Global } = await import("../src/global")
const { Skill } = await import("../src/skill")
const { Instance } = await import("../src/project/instance")

await Global.ensureDirs()

const a = path.join(tmp, "project-a")
const b = path.join(tmp, "project-b")
for (const dir of [a, b]) {
  const file = path.join(dir, ".aether", "skills", "probe", "SKILL.md")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "---\nname: probe\ndescription: probe\n---\n\n# probe\n")
}

await Instance.provide({ directory: a, fn: () => Skill.all() })
await Instance.provide({ directory: b, fn: () => Skill.all() })
await sleep(300)

const rows = out.filter((line) => line.startsWith("[skill watch] init backend="))
const hitA = rows.some((line) => line.includes(`dir=${a}`))
const hitB = rows.some((line) => line.includes(`dir=${b}`))

if (!hitA || !hitB) {
  throw new Error(
    [
      "expected watcher init for both directories",
      `project-a=${hitA ? 1 : 0}`,
      `project-b=${hitB ? 1 : 0}`,
      `lines=${rows.join(" | ") || "(none)"}`,
    ].join(" "),
  )
}

console.log(`[verify] init lines=${rows.length}`)
console.log("[verify] ok: per-directory ensure throttle allows both watchers")

await Instance.provide({ directory: a, fn: () => Instance.dispose() })
await Instance.provide({ directory: b, fn: () => Instance.dispose() })
