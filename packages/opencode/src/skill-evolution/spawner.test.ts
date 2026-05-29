import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@/global"
import { Spawner } from "./spawner"

describe("Spawner path helpers", () => {
  test("skillEvolutionDir returns <data>/skill-evolution/<folderName>/skills", () => {
    const folderName = "abc12345deadbeef0123456789abcdef01234567"
    expect(Spawner.skillEvolutionDir(folderName)).toBe(
      path.join(Global.Path.data, "skill-evolution", folderName, "skills"),
    )
  })

  test("skillEvolutionBase returns <data>/skill-evolution/<folderName>", () => {
    const folderName = "abc12345deadbeef0123456789abcdef01234567"
    expect(Spawner.skillEvolutionBase(folderName)).toBe(
      path.join(Global.Path.data, "skill-evolution", folderName),
    )
  })

  test("skillEvolutionDir is a subdirectory of skillEvolutionBase", () => {
    const folderName = "deadbeef" + "00".repeat(16)
    expect(Spawner.skillEvolutionDir(folderName)).toStartWith(Spawner.skillEvolutionBase(folderName) + path.sep)
  })

  test("different folderNames produce different paths", () => {
    expect(Spawner.skillEvolutionDir("proj-a")).not.toBe(Spawner.skillEvolutionDir("proj-b"))
    expect(Spawner.skillEvolutionBase("proj-a")).not.toBe(Spawner.skillEvolutionBase("proj-b"))
  })

  test("skillEvolutionRoot returns <data>/skill-evolution", () => {
    expect(Spawner.skillEvolutionRoot()).toBe(path.join(Global.Path.data, "skill-evolution"))
  })

  test("skillEvolutionShared returns <data>/skill-evolution/shared", () => {
    expect(Spawner.skillEvolutionShared()).toBe(path.join(Global.Path.data, "skill-evolution", "shared"))
  })

  test("skillEvolutionShared sits directly under skillEvolutionRoot", () => {
    // shared/ is a sibling of <projectId>/ sub-folders under skillEvolutionRoot.
    expect(path.dirname(Spawner.skillEvolutionShared())).toBe(Spawner.skillEvolutionRoot())
  })
})

describe("Spawner.skillFolderName", () => {
  test("returns projectId verbatim (no basename prefix)", () => {
    expect(Spawner.skillFolderName("/home/user/my-project", "a3f2bc1d2e3f4567")).toBe("a3f2bc1d2e3f4567")
  })

  test("ignores special chars in project directory — output is just the id", () => {
    expect(Spawner.skillFolderName("/home/user/My Project!", "abc12345")).toBe("abc12345")
  })

  test("works even when project directory is /", () => {
    expect(Spawner.skillFolderName("/", "abc12345deadbeef")).toBe("abc12345deadbeef")
  })

  test("same projectId always produces same folder name regardless of directory", () => {
    const id = "aabbccdd11223344"
    expect(Spawner.skillFolderName("/home/user/proj-a", id)).toBe(
      Spawner.skillFolderName("/home/user/proj-b", id),
    )
  })
})
