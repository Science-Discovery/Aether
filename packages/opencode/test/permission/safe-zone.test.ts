import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SafeZone } from "../../src/permission/safe-zone"
import { Wildcard } from "../../src/util/wildcard"
import { Global } from "../../src/global"
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
    const rules = await SafeZone.rules(undefined, worktree)
    const outside = "D:/secrets/keys.txt"
    const rel = path.relative(worktree, outside)
    expect(lastAction(rules, "edit", rel)).toBeUndefined()

    const zone = await SafeZone.rules({ private: ["D:/secrets/**"] }, worktree)
    expect(lastAction(zone, "edit", rel)).toBe("deny")

    const open = await SafeZone.rules({ open: ["D:/notes/**"] }, worktree)
    const relNote = path.relative(worktree, "D:/notes/todo.md")
    expect(lastAction(open, "edit", relNote)).toBe("allow")
  })

  test("edit rules use relative form for in-worktree zones", async () => {
    const worktree = path.join(os.tmpdir(), "worktree")
    const rules = await SafeZone.rules({ private: ["secrets/**"] }, worktree)
    expect(lastAction(rules, "edit", "secrets/key.pem")).toBe("deny")
    expect(lastAction(rules, "read", path.join(worktree, "secrets", "key.pem"))).toBe("deny")
  })

  test("user open overrides built-in private (user open compiled after built-in private)", async () => {
    const rules = await SafeZone.rules(
      { open: [`${data.replaceAll("\\", "/")}/auth.json`] },
      path.join(os.tmpdir(), "worktree"),
    )
    expect(lastAction(rules, "read", path.join(data, "auth.json"))).toBe("allow")
    expect(
      lastAction(rules, "edit", path.relative(path.join(os.tmpdir(), "worktree"), path.join(data, "auth.json"))),
    ).toBe("allow")
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
