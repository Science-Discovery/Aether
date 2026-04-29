import os from "os"
import path from "path"
import fs from "fs/promises"

function check(ok: boolean, msg: string) {
  if (ok) return
  throw new Error(msg)
}

const root = path.join(os.tmpdir(), `skill-toggle-verify-${Date.now()}`)
await fs.mkdir(root, { recursive: true })

process.env["XDG_DATA_HOME"] = path.join(root, "share")
process.env["XDG_CACHE_HOME"] = path.join(root, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(root, "config")
process.env["XDG_STATE_HOME"] = path.join(root, "state")
process.env["OPENCODE_TEST_HOME"] = path.join(root, "home")
process.env["OPENCODE_DB"] = ":memory:"
process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"

const cacheDir = path.join(root, "cache", "aether")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "21")

const { Global } = await import("../src/global")
const { Config } = await import("../src/config/config")
const { Skill } = await import("../src/skill")
const { Instance } = await import("../src/project/instance")
type Item = { name: string }
const has = (list: Item[], name: string) => list.some((item) => item.name === name)

await Global.ensureDirs()

const dir = path.join(root, "project")
await fs.mkdir(dir, { recursive: true })

const skill = "toggle-check"
const file = path.join(dir, ".claude", "skills", skill, "SKILL.md")
await fs.mkdir(path.dirname(file), { recursive: true })
await fs.writeFile(file, `---\nname: ${skill}\ndescription: verify toggle\n---\n\n# toggle\n`)

const before = await Instance.provide({ directory: dir, fn: () => Skill.all() })
check(has(before, skill), "expected skill before toggle")

let calls = 0
const prev = Instance.disposeAll
;(Instance as { disposeAll: typeof Instance.disposeAll }).disposeAll = async () => {
  calls++
  return
}

await Config.toggleSkill(skill, false)
const off = await Instance.provide({ directory: dir, fn: () => Skill.all() })
check(!has(off, skill), "expected skill hidden after disable")
check(calls === 0, "toggle should not call Instance.disposeAll")

const cfgOff = await Config.getGlobal()
check(cfgOff.skills?.disabled?.includes(skill) ?? false, "expected disabled persisted")

await Config.toggleSkill(skill, true)
const on = await Instance.provide({ directory: dir, fn: () => Skill.all() })
check(has(on, skill), "expected skill visible after enable")
check(calls === 0, "enable should not call Instance.disposeAll")

await Config.toggleSkill(skill, false)
await Config.toggleSkill(skill, false)
const dup = await Config.getGlobal()
const count = (dup.skills?.disabled ?? []).filter((x) => x === skill).length
check(count === 1, "expected disabled list unique")

await Promise.all([Config.toggleSkill(skill, true), Config.toggleSkill(skill, false), Config.toggleSkill(skill, true)])
const concurrent = await Config.getGlobal()
const concurrentCount = (concurrent.skills?.disabled ?? []).filter((x) => x === skill).length
check(concurrentCount <= 1, "concurrent toggles should not produce duplicate disabled entries")
;(Instance as { disposeAll: typeof Instance.disposeAll }).disposeAll = prev
await Instance.disposeAll()
await fs.rm(root, { recursive: true, force: true }).catch(() => {})

console.log("[verify-skill-toggle-cache] ok")
