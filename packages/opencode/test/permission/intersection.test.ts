import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

describe("Permission.intersection", () => {
  test("parent deny overrides child allow", () => {
    const parent: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]
    const child: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "*", result).action).toBe("deny")
  })

  test("child deny is preserved when parent allows", () => {
    const parent: Permission.Ruleset = [{ permission: "edit", pattern: "*", action: "allow" }]
    const child: Permission.Ruleset = [{ permission: "edit", pattern: "*", action: "deny" }]
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("edit", "*", result).action).toBe("deny")
  })

  test("both allow produces allow", () => {
    const parent: Permission.Ruleset = [{ permission: "read", pattern: "*", action: "allow" }]
    const child: Permission.Ruleset = [{ permission: "read", pattern: "*", action: "allow" }]
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("read", "*", result).action).toBe("allow")
  })

  test("child ask is preserved when parent allows", () => {
    const parent: Permission.Ruleset = [{ permission: "read", pattern: "*", action: "allow" }]
    const child: Permission.Ruleset = [{ permission: "read", pattern: "*", action: "ask" }]
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("read", "*", result).action).toBe("ask")
  })

  test("override allow works when parent does not deny", () => {
    const parent: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]
    const child: Permission.Ruleset = [{ permission: "task", pattern: "*", action: "deny" }]
    const override: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "task", pattern: "*", action: "allow" },
    ]
    const result = Permission.intersection(parent, child, override)
    expect(Permission.evaluate("bash", "*", result).action).toBe("deny")
    expect(Permission.evaluate("task", "*", result).action).toBe("allow")
  })

  test("parent deny rules not in child are inherited", () => {
    const parent: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]
    const child: Permission.Ruleset = [{ permission: "read", pattern: "*", action: "allow" }]
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "*", result).action).toBe("deny")
  })

  test("empty rulesets produce empty result", () => {
    const result = Permission.intersection([], [])
    expect(result).toEqual([])
  })
})
