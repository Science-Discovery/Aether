import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@/global"
import { Spawner } from "./spawner"

describe("Spawner path helpers", () => {
  test("skillSessionsDir returns <home>/.aether/skill-sessions/<folderName>/skills", () => {
    const folderName = "my-project-abc12345"
    expect(Spawner.skillSessionsDir(folderName)).toBe(
      path.join(Global.Path.home, ".aether", "skill-sessions", folderName, "skills"),
    )
  })

  test("skillSessionsBase returns <home>/.aether/skill-sessions/<folderName>", () => {
    const folderName = "my-project-abc12345"
    expect(Spawner.skillSessionsBase(folderName)).toBe(
      path.join(Global.Path.home, ".aether", "skill-sessions", folderName),
    )
  })

  test("skillSessionsDir is a subdirectory of skillSessionsBase", () => {
    const folderName = "test-proj-deadbeef"
    expect(Spawner.skillSessionsDir(folderName)).toStartWith(Spawner.skillSessionsBase(folderName) + path.sep)
  })

  test("different folderNames produce different paths", () => {
    expect(Spawner.skillSessionsDir("proj-a")).not.toBe(Spawner.skillSessionsDir("proj-b"))
    expect(Spawner.skillSessionsBase("proj-a")).not.toBe(Spawner.skillSessionsBase("proj-b"))
  })

  test("OPENCODE_TEST_HOME override is respected by Global.Path.home", () => {
    const original = process.env.OPENCODE_TEST_HOME
    try {
      process.env.OPENCODE_TEST_HOME = "/custom/home"
      expect(Spawner.skillSessionsDir("xyz")).toBe(
        path.join("/custom/home", ".aether", "skill-sessions", "xyz", "skills"),
      )
    } finally {
      if (original === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = original
    }
  })
})

describe("Spawner.skillFolderName", () => {
  test("combines sanitized basename with short projectId", () => {
    expect(Spawner.skillFolderName("/home/user/my-project", "a3f2bc1d2e3f4567")).toBe("my-project-a3f2bc1d")
  })

  test("sanitizes spaces and special chars in project name", () => {
    expect(Spawner.skillFolderName("/home/user/My Project!", "abc12345")).toBe("My-Project-abc12345")
  })

  test("falls back to short hash when basename is empty after sanitization", () => {
    expect(Spawner.skillFolderName("/", "abc12345deadbeef")).toBe("abc12345")
  })

  test("different directories produce different folder names for same projectId", () => {
    const id = "aabbccdd11223344"
    expect(Spawner.skillFolderName("/home/user/proj-a", id)).not.toBe(
      Spawner.skillFolderName("/home/user/proj-b", id),
    )
  })
})
