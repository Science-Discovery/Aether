import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

const FILE_TOOLS = ["read", "edit", "write", "glob", "grep", "apply_patch", "multiedit"]

describe("file_scope interception", () => {
  test("file tool outside scope is denied", () => {
    const scope = ["src/auth/**", "package.json"]
    const ruleset: Permission.Ruleset = [{ permission: "edit", pattern: "*", action: "allow" }]
    const result = Permission.evaluateWithScope("edit", "src/main.ts", ruleset, scope)
    expect(result.action).toBe("deny")
    expect(result.scopeMatch).toBe(false)
  })

  test("file tool inside scope is allowed", () => {
    const scope = ["src/auth/**", "package.json"]
    const ruleset: Permission.Ruleset = [{ permission: "edit", pattern: "*", action: "allow" }]
    const result = Permission.evaluateWithScope("edit", "src/auth/login.ts", ruleset, scope)
    expect(result.action).toBe("allow")
    expect(result.scopeMatch).toBe(true)
  })

  test("file tool matching exact scope pattern is allowed", () => {
    const scope = ["src/auth/**", "package.json"]
    const ruleset: Permission.Ruleset = [{ permission: "read", pattern: "*", action: "allow" }]
    const result = Permission.evaluateWithScope("read", "package.json", ruleset, scope)
    expect(result.action).toBe("allow")
    expect(result.scopeMatch).toBe(true)
  })

  test("non-file tool ignores scope", () => {
    const scope = ["src/auth/**"]
    const ruleset: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
    const result = Permission.evaluateWithScope("bash", "/usr/bin/ls", ruleset, scope)
    expect(result.action).toBe("allow")
    expect(result.scopeMatch).toBe(true)
  })

  test("scope check respects existing deny rule first", () => {
    const scope = ["src/auth/**"]
    const ruleset: Permission.Ruleset = [{ permission: "edit", pattern: "*", action: "deny" }]
    const result = Permission.evaluateWithScope("edit", "src/auth/login.ts", ruleset, scope)
    expect(result.action).toBe("deny")
    expect(result.scopeMatch).toBe(false)
  })

  test("no scope means no restriction", () => {
    const ruleset: Permission.Ruleset = [{ permission: "edit", pattern: "*", action: "allow" }]
    const result = Permission.evaluateWithScope("edit", "any/path.ts", ruleset)
    expect(result.action).toBe("allow")
    expect(result.scopeMatch).toBe(true)
  })

  test("all FILE_TOOLS are subject to scope", () => {
    const scope = ["src/**"]
    const ruleset: Permission.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]
    for (const tool of FILE_TOOLS) {
      const inside = Permission.evaluateWithScope(tool, "src/foo.ts", ruleset, scope)
      expect(inside.action).toBe("allow")
      const outside = Permission.evaluateWithScope(tool, "lib/bar.ts", ruleset, scope)
      expect(outside.action).toBe("deny")
    }
  })
})
