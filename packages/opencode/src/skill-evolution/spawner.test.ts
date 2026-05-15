import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@/global"
import { Spawner } from "./spawner"

describe("Spawner path helpers", () => {
  test("skillSessionsDir returns <home>/.aether/skill-sessions/<projectId>/skills", () => {
    const projectId = "abc123"
    expect(Spawner.skillSessionsDir(projectId)).toBe(
      path.join(Global.Path.home, ".aether", "skill-sessions", projectId, "skills"),
    )
  })

  test("skillSessionsBase returns <home>/.aether/skill-sessions/<projectId>", () => {
    const projectId = "abc123"
    expect(Spawner.skillSessionsBase(projectId)).toBe(
      path.join(Global.Path.home, ".aether", "skill-sessions", projectId),
    )
  })

  test("skillSessionsDir is a subdirectory of skillSessionsBase", () => {
    const projectId = "test-proj"
    expect(Spawner.skillSessionsDir(projectId)).toStartWith(Spawner.skillSessionsBase(projectId) + path.sep)
  })

  test("different projectIds produce different paths", () => {
    expect(Spawner.skillSessionsDir("proj-a")).not.toBe(Spawner.skillSessionsDir("proj-b"))
    expect(Spawner.skillSessionsBase("proj-a")).not.toBe(Spawner.skillSessionsBase("proj-b"))
  })

  test("OPENCODE_TEST_HOME override is respected by Global.Path.home", () => {
    const original = process.env.OPENCODE_TEST_HOME
    try {
      process.env.OPENCODE_TEST_HOME = "/custom/home"
      // Global.Path.home is a getter that reads the env var, so it picks up the override
      expect(Spawner.skillSessionsDir("xyz")).toBe(
        path.join("/custom/home", ".aether", "skill-sessions", "xyz", "skills"),
      )
    } finally {
      if (original === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = original
    }
  })
})
