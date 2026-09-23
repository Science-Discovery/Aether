import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SafeZone } from "../../src/permission/safe-zone"
import { Wildcard } from "../../src/util/wildcard"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import type { Permission } from "../../src/permission"

function lastAction(rules: Permission.Ruleset, permission: string, pattern: string) {
  let action: "allow" | "deny" | "ask" | undefined
  for (const rule of rules) {
    if (Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) action = rule.action
  }
  return action
}

function allActions(rules: Permission.Ruleset, permission: string, pattern: string) {
  return {
    read: lastAction(rules, "read", pattern),
    external_read: lastAction(rules, "external_read", pattern),
    external_directory: lastAction(rules, "external_directory", pattern),
  }
}

const data = Global.Path.data
const slash = (p: string) => p.replaceAll("\\", "/")

describe("SafeZone.rules", () => {
  test("external reads are allowed by default outside all zones", async () => {
    const rules = await SafeZone.rules(undefined, path.join(os.tmpdir(), "worktree"))
    expect(lastAction(rules, "external_read", "C:/random/place/*")).toBe("allow")
  })

  test("no blanket read allow is emitted (preserves .env and user read rules)", async () => {
    const rules = await SafeZone.rules(undefined, path.join(os.tmpdir(), "worktree"))
    expect(lastAction(rules, "read", "C:/random/place/file.env")).toBeUndefined()
    expect(lastAction(rules, "read", "C:/random/place/file.txt")).toBeUndefined()
  })

  test("built-in open zones: tmpdir, data, cache readable and writable", async () => {
    const rules = await SafeZone.rules(undefined, path.join(os.tmpdir(), "worktree"))
    const file = path.join(os.tmpdir(), "scratch.txt")
    expect(lastAction(rules, "read", file)).toBe("allow")
    expect(lastAction(rules, "external_read", path.join(os.tmpdir(), "*"))).toBe("allow")
    expect(lastAction(rules, "external_directory", path.join(os.tmpdir(), "*"))).toBe("allow")
    expect(lastAction(rules, "external_directory", path.join(data, "*"))).toBe("allow")
    expect(lastAction(rules, "read", path.join(Global.Path.cache, "lsp", "server.bin"))).toBe("allow")
  })

  test("built-in open zone covers tmpdir realpath form (macOS /var/folders -> /private/var)", async () => {
    const rules = await SafeZone.rules(undefined, path.join(os.tmpdir(), "worktree"))
    const real = await fs.realpath(os.tmpdir()).catch(() => undefined)
    if (!real || real === os.tmpdir()) return
    expect(lastAction(rules, "external_directory", `${real.replaceAll("\\", "/")}/*`)).toBe("allow")
  })

  test("built-in private: auth.json, db files, memory, log denied for read and write", async () => {
    const rules = await SafeZone.rules(undefined, path.join(os.tmpdir(), "worktree"))

    const auth = path.join(data, "auth.json")
    expect(lastAction(rules, "read", auth)).toBe("deny")
    expect(lastAction(rules, "external_read", auth)).toBe("deny")
    expect(lastAction(rules, "external_directory", auth)).toBe("deny")

    const authTemp = path.join(data, "auth.json.tmp-123")
    expect(lastAction(rules, "read", authTemp)).toBe("deny")

    const db = path.join(os.tmpdir(), "aether.db")
    expect(lastAction(rules, "read", db)).toBe("deny")
    expect(lastAction(rules, "external_read", db)).toBe("deny")

    const wal = path.join(data, "aether.db-wal")
    expect(lastAction(rules, "read", wal)).toBe("deny")

    const memory = path.join(data, "memory", "AETHER_MEMORY.md")
    expect(lastAction(rules, "read", memory)).toBe("deny")
    expect(lastAction(rules, "external_directory", memory)).toBe("deny")

    const log = path.join(data, "log", "dev.log")
    expect(lastAction(rules, "read", log)).toBe("deny")
  })

  test("built-in private denies inside built-in open (private layer compiled later)", async () => {
    const rules = await SafeZone.rules(undefined, path.join(os.tmpdir(), "worktree"))
    const db = path.join(os.tmpdir(), "nested", "aether-local.db")
    expect(lastAction(rules, "read", db)).toBe("deny")
    expect(lastAction(rules, "external_directory", db)).toBe("deny")
  })

  test("edit rules are compiled to worktree-relative patterns", async () => {
    const worktree = path.join(os.tmpdir(), "worktree")
    const zoneDir = slash(path.join(os.homedir(), "sz-zone-test"))
    const rules = await SafeZone.rules(undefined, worktree)
    const rel = path.relative(worktree, path.join(zoneDir, "keys.txt"))
    expect(lastAction(rules, "edit", rel)).toBeUndefined()

    const zone = await SafeZone.rules({ private: [`${zoneDir}/**`] }, worktree)
    expect(lastAction(zone, "edit", rel)).toBe("deny")

    const open = await SafeZone.rules({ open: [`${zoneDir}/notes/**`] }, worktree)
    const relNote = path.relative(worktree, path.join(zoneDir, "notes", "todo.md"))
    expect(lastAction(open, "edit", relNote)).toBeUndefined()
    expect(lastAction(open, "external_directory", path.join(zoneDir, "notes", "*"))).toBe("allow")
  })

  test("open zones emit no edit rules so plan-mode edit deny survives", async () => {
    await using tmp = await tmpdir({ git: true })
    const { Agent } = await import("../../src/agent/agent")
    const { Permission } = await import("../../src/permission")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const worktree = tmp.path
        const rules = await SafeZone.rules({ open: ["dist/**", "D:/notes/**"] }, worktree)
        const plan = await Agent.get("plan")
        const merged = Permission.merge(plan!.permission, rules)
        expect(Permission.evaluate("edit", "dist/app.js", merged).action).toBe("deny")
        expect(Permission.evaluate("edit", "D:/notes/todo.md", merged).action).toBe("deny")
        expect(Permission.evaluate("read", path.join(worktree, "dist", "app.js"), merged).action).toBe("allow")
        const build = await Agent.get("build")
        const buildMerged = Permission.merge(build!.permission, rules)
        expect(Permission.evaluate("edit", path.join(worktree, "dist", "app.js"), buildMerged).action).toBe("allow")
      },
    })
  })

  test("worktree inside an open zone emits no collapsing edit pattern", async () => {
    const worktree = path.join(os.tmpdir(), "worktree")
    const rules = await SafeZone.rules(undefined, worktree)
    const collapsing = rules.filter((r) => r.permission === "edit" && /^(\.\.\/)+\*+$/.test(r.pattern))
    expect(collapsing).toEqual([])
  })

  test("user permission denies beat the safe-tier blanket external_read allow", async () => {
    const worktree = path.join(os.tmpdir(), "worktree")
    const denies: Permission.Ruleset = [
      { permission: "external_read", pattern: "**/secrets/**", action: "deny" },
      { permission: "external_directory", pattern: "**/secrets/**", action: "deny" },
      { permission: "read", pattern: "*.pem", action: "deny" },
    ]
    const rules = await SafeZone.rules(undefined, worktree, denies)
    expect(lastAction(rules, "external_read", "D:/proj/secrets/a.txt")).toBe("deny")
    expect(lastAction(rules, "external_directory", "D:/proj/secrets/*")).toBe("deny")
    expect(lastAction(rules, "read", "D:/anywhere/key.pem")).toBe("deny")
    expect(lastAction(rules, "external_read", "D:/proj/other/a.txt")).toBe("allow")
  })

  test("user denies win even over user open zones (fail-closed)", async () => {
    const worktree = path.join(os.tmpdir(), "worktree")
    const denies: Permission.Ruleset = [{ permission: "external_directory", pattern: "**/secrets/**", action: "deny" }]
    const rules = await SafeZone.rules({ open: ["D:/secrets/**"] }, worktree, denies)
    expect(lastAction(rules, "external_directory", "D:/secrets/*")).toBe("deny")
    expect(lastAction(rules, "read", "D:/secrets/a.txt")).toBe("allow")
  })

  test("edit rules use relative form for in-worktree zones", async () => {
    const worktree = path.join(os.tmpdir(), "worktree")
    const rules = await SafeZone.rules({ private: ["secrets/**"] }, worktree)
    expect(lastAction(rules, "edit", "secrets/key.pem")).toBe("deny")
    expect(lastAction(rules, "read", path.join(worktree, "secrets", "key.pem"))).toBe("deny")
  })

  test("user open overrides built-in private for reads, writes stay denied (fail-closed)", async () => {
    const rules = await SafeZone.rules(
      { open: [`${data.replaceAll("\\", "/")}/auth.json`] },
      path.join(os.tmpdir(), "worktree"),
    )
    expect(lastAction(rules, "read", path.join(data, "auth.json"))).toBe("allow")
    expect(lastAction(rules, "external_directory", path.join(data, "auth.json"))).toBe("allow")
    expect(
      lastAction(rules, "edit", path.relative(path.join(os.tmpdir(), "worktree"), path.join(data, "auth.json"))),
    ).toBe("deny")
  })

  test("user private overrides built-in open and user open (fail-closed)", async () => {
    const tmpSub = `${os.tmpdir().replaceAll("\\", "/")}/private-thing`
    const rules = await SafeZone.rules(
      {
        private: [`${tmpSub}/**`, "D:/secrets/public/**"],
        open: [`${tmpSub}/open/**`, "D:/secrets/**"],
      },
      path.join(os.tmpdir(), "worktree"),
    )
    expect(lastAction(rules, "read", `${tmpSub}/x.txt`)).toBe("deny")
    expect(lastAction(rules, "read", `${tmpSub}/open/x.txt`)).toBe("deny")
    expect(lastAction(rules, "read", "D:/secrets/other/x.txt")).toBe("allow")
    expect(lastAction(rules, "read", "D:/secrets/public/x.txt")).toBe("deny")
  })

  test("windows-style backslash globs from config are normalized", async () => {
    if (process.platform !== "win32") return
    const rules = await SafeZone.rules({ private: ["D:\\secrets\\**"] }, path.join(os.tmpdir(), "worktree"))
    expect(lastAction(rules, "read", "D:/secrets/a.txt")).toBe("deny")
    expect(lastAction(rules, "edit", path.relative(path.join(os.tmpdir(), "worktree"), "D:/secrets/a.txt"))).toBe(
      "deny",
    )
  })

  test("basename globs match absolute read patterns and relative edit patterns", async () => {
    const rules = await SafeZone.rules({ private: ["*.pem"] }, path.join(os.tmpdir(), "worktree"))
    expect(lastAction(rules, "read", "C:/anywhere/key.pem")).toBe("deny")
    expect(lastAction(rules, "read", path.join(os.tmpdir(), "worktree", "cert.pem"))).toBe("deny")
    expect(lastAction(rules, "edit", "src/cert.pem")).toBe("deny")
    expect(lastAction(rules, "read", "C:/anywhere/key.txt")).toBeUndefined()
  })

  test("bare directory globs expand to cover contents", async () => {
    const rules = await SafeZone.rules({ open: ["D:/openzone"] }, path.join(os.tmpdir(), "worktree"))
    expect(lastAction(rules, "read", "D:/openzone/a.txt")).toBe("allow")
    expect(lastAction(rules, "external_directory", "D:/openzone/*")).toBe("allow")
  })

  test("trailing slashes are trimmed", async () => {
    const rules = await SafeZone.rules({ open: ["D:/openzone/"] }, path.join(os.tmpdir(), "worktree"))
    expect(lastAction(rules, "read", "D:/openzone/a.txt")).toBe("allow")
  })

  test("tilde globs expand to home directory", async () => {
    const rules = await SafeZone.rules({ private: ["~/secrets/**"] }, path.join(os.tmpdir(), "worktree"))
    expect(lastAction(rules, "read", path.join(os.homedir(), "secrets", "a.txt"))).toBe("deny")
  })

  test("relative globs resolve against worktree for absolute keys", async () => {
    const worktree = path.join(os.tmpdir(), "worktree")
    const rules = await SafeZone.rules({ private: ["vault/*.key"] }, worktree)
    expect(lastAction(rules, "read", path.join(worktree, "vault", "a.key"))).toBe("deny")
    expect(lastAction(rules, "read", "C:/other/vault/a.key")).toBeUndefined()
  })

  test("empty zone entries are skipped", async () => {
    const rules = await SafeZone.rules({ private: [""], open: [] }, path.join(os.tmpdir(), "worktree"))
    const read = rules.filter((r) => r.permission === "read")
    const baseline = await SafeZone.rules(undefined, path.join(os.tmpdir(), "worktree"))
    expect(read.length).toBe(baseline.filter((x) => x.permission === "read").length)
  })
})
