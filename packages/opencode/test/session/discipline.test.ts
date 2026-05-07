import { describe, expect, test } from "bun:test"
import { fromOverride } from "../../src/session/discipline"

describe("Discipline.fromOverride", () => {
  test("single action creates wildcard pattern", () => {
    const result = fromOverride({ edit: ["allow"], bash: ["deny"] })
    expect(result).toEqual([
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ])
  })

  test("action with path patterns creates scoped rules only", () => {
    const result = fromOverride({ edit: ["allow", "src/**"] })
    expect(result).toEqual([{ permission: "edit", pattern: "src/**", action: "allow" }])
  })

  test("empty override produces empty ruleset", () => {
    const result = fromOverride({})
    expect(result).toEqual([])
  })

  test("multiple path patterns create multiple rules", () => {
    const result = fromOverride({ glob: ["allow", "src/**", "test/**"] })
    expect(result).toContainEqual({ permission: "glob", pattern: "src/**", action: "allow" })
    expect(result).toContainEqual({ permission: "glob", pattern: "test/**", action: "allow" })
  })

  test("invalid action value is skipped", () => {
    const result = fromOverride({ edit: ["maybe"], bash: ["deny"] })
    expect(result).toEqual([{ permission: "bash", pattern: "*", action: "deny" }])
  })

  test("ask action is valid", () => {
    const result = fromOverride({ bash: ["ask"] })
    expect(result).toEqual([{ permission: "bash", pattern: "*", action: "ask" }])
  })
})
