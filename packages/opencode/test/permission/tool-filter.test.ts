import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

describe("resolveTools permission filtering logic", () => {
  const EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"]

  test("edit tools denied when edit permission is deny", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
    ]
    for (const tool of EDIT_TOOLS) {
      const permKey = EDIT_TOOLS.includes(tool) ? "edit" : tool
      const rule = Permission.evaluate(permKey, "*", ruleset)
      expect(rule.action).toBe("deny")
    }
  })

  test("non-edit tools denied when their permission is deny", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "allow" },
    ]
    expect(Permission.evaluate("bash", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("task", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("edit", "*", ruleset).action).toBe("allow")
  })

  test("all tools allowed when no deny rules", () => {
    const ruleset: Permission.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]
    expect(Permission.evaluate("edit", "*", ruleset).action).toBe("allow")
    expect(Permission.evaluate("bash", "*", ruleset).action).toBe("allow")
    expect(Permission.evaluate("read", "*", ruleset).action).toBe("allow")
    expect(Permission.evaluate("task", "*", ruleset).action).toBe("allow")
  })

  test("Permission.disabled returns correct set of denied tools", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
    ]
    const disabled = Permission.disabled(["todowrite", "task", "edit", "write", "bash"], ruleset)
    expect(disabled.has("todowrite")).toBe(true)
    expect(disabled.has("task")).toBe(true)
    expect(disabled.has("edit")).toBe(true)
    expect(disabled.has("write")).toBe(true)
    expect(disabled.has("bash")).toBe(true)
  })

  test("intersection produces rules that correctly deny tools", () => {
    const parent: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "allow" },
    ]
    const child: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
    ]
    const effective = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "*", effective).action).toBe("deny")
    expect(Permission.evaluate("edit", "*", effective).action).toBe("allow")
  })

  test("tools with wildcard deny pattern block all matching tools", () => {
    const ruleset: Permission.Ruleset = [{ permission: "*", pattern: "*", action: "deny" }]
    expect(Permission.evaluate("edit", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("read", "*", ruleset).action).toBe("deny")
  })
})
