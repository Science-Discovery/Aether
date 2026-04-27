import fs from "fs/promises"
import os from "os"
import path from "path"
import { setTimeout as sleep } from "timers/promises"

const tmp = path.join(os.tmpdir(), `skill-watch-parcel-missing-${Date.now()}`)
await fs.mkdir(tmp, { recursive: true })

process.env["XDG_DATA_HOME"] = path.join(tmp, "share")
process.env["XDG_CACHE_HOME"] = path.join(tmp, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(tmp, "config")
process.env["XDG_STATE_HOME"] = path.join(tmp, "state")
process.env["OPENCODE_TEST_HOME"] = path.join(tmp, "home")
process.env["OPENCODE_DB"] = ":memory:"
process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"
process.env["OPENCODE_SKILL_WATCHER_BACKEND"] = "parcel"

const cache = path.join(tmp, "cache", "aether")
await fs.mkdir(cache, { recursive: true })
await fs.writeFile(path.join(cache, "version"), "21")

const rows: string[] = []
const prev = console.log.bind(console)
console.log = (...args: unknown[]) => {
  const line = args.map((item) => String(item)).join(" ")
  rows.push(line)
  prev(...args)
}

const { Global } = await import("../src/global")
const { Skill } = await import("../src/skill")
const { Instance } = await import("../src/project/instance")

await Global.ensureDirs()

const dir = path.join(tmp, "project")
const file = path.join(dir, ".aether", "skills", "probe", "SKILL.md")
await fs.mkdir(path.dirname(file), { recursive: true })
await fs.writeFile(file, "---\nname: probe\ndescription: probe\n---\n\n# probe\n")

await Instance.provide({ directory: dir, fn: () => Skill.all() })
await sleep(350)

const watch = rows.filter((line) => line.startsWith("[skill watch]"))
const hasMiss = watch.some((line) => line.includes("roots all=") && line.includes("miss:"))
const skip = watch.find((line) => line.includes("parcel skip missing roots="))
const bad0 = watch.find((line) => line.includes("parcel subscribe failed") && line.includes("exists=0"))
const sum = watch.find((line) => line.includes("parcel subscribe summary"))
const init = watch.find((line) => line.includes("init backend="))

if (!hasMiss) throw new Error(`expected missing roots in log: ${watch.join(" | ")}`)
if (!skip) throw new Error(`expected skip-missing log: ${watch.join(" | ")}`)
if (bad0) throw new Error(`missing root was subscribed unexpectedly: ${bad0}`)
if (!sum) throw new Error(`missing parcel summary log: ${watch.join(" | ")}`)
if (!init) throw new Error(`missing init backend log: ${watch.join(" | ")}`)

console.log(`[verify] ${skip}`)
console.log(`[verify] ${sum}`)
console.log(`[verify] ${init}`)
console.log("[verify] ok: missing roots are skipped before parcel subscribe")

await Instance.provide({ directory: dir, fn: () => Instance.dispose() })
