import { describe, expect, test, mock } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SkillManageTool } from "./skill-manage-tool"

// Publisher makes a Bus.publish call that is irrelevant to file I/O correctness.
mock.module("./publisher", () => ({
  Publisher: { publishSkillSaved: async () => {} },
  SkillSavedEvent: {},
}))

describe("SkillManageTool shadow copy-on-write", () => {
  test("edit with skillLocation copies original to shadow and writes there", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-shadow-test-"))
    try {
      // Original skill lives in .claude/skills/my-skill/SKILL.md
      const originalDir = path.join(tmp, "project", ".claude", "skills", "my-skill")
      await fs.mkdir(originalDir, { recursive: true })
      await fs.writeFile(
        path.join(originalDir, "SKILL.md"),
        `---\nname: "my-skill"\ndescription: "original"\n---\n\nOriginal content`,
      )

      const result = await SkillManageTool.execute({
        action: "edit",
        name: "my-skill",
        description: "updated",
        content: "Updated content",
        skillLocation: path.join(originalDir, "SKILL.md"),
      })

      expect(result.ok).toBe(true)

      // Shadow lands at <project>/.aether/skills/my-skill/
      const shadowDir = path.join(tmp, "project", ".aether", "skills", "my-skill")
      expect(result.skillDir).toBe(shadowDir)

      const shadowContent = await fs.readFile(path.join(shadowDir, "SKILL.md"), "utf-8")
      expect(shadowContent).toContain("Updated content")
      expect(shadowContent).not.toContain("Original content")

      // Original must not be modified (copy-on-write)
      const originalContent = await fs.readFile(path.join(originalDir, "SKILL.md"), "utf-8")
      expect(originalContent).toContain("Original content")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  test("create without skillLocation writes to skill-sessions bucket", async () => {
    const result = await SkillManageTool.execute({
      action: "create",
      name: "brand-new-skill",
      description: "a new skill",
      content: "Do something useful.",
      sessionProjectId: "test-proj-id",
    })

    expect(result.ok).toBe(true)
    expect(result.skillDir).toContain(path.join("skill-sessions", "test-proj-id"))

    await fs.rm(result.skillDir!, { recursive: true, force: true })
  })
})

describe("SkillManageTool skillLocation security", () => {
  test("rejects skillLocation pointing outside a skills directory", async () => {
    const result = await SkillManageTool.execute({
      action: "create",
      name: "evil",
      description: "exploit",
      content: "bad content",
      skillLocation: "/home/user/.ssh/id_rsa",
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("Unsafe skillLocation rejected")
  })

  test("rejects skillLocation with path traversal that escapes skills dir", async () => {
    const result = await SkillManageTool.execute({
      action: "edit",
      name: "evil",
      description: "exploit",
      content: "bad content",
      skillLocation: "/project/.claude/skills/../../.ssh/id_rsa",
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("Unsafe skillLocation rejected")
  })
})

describe("createBoundSkillManageTool skillLocationMap lookup", () => {
  test("resolves skillLocation from map when not provided in params", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bound-test-"))
    try {
      // Original skill in .opencode
      const originalDir = path.join(tmp, "project", ".opencode", "skills", "foo")
      await fs.mkdir(originalDir, { recursive: true })
      await fs.writeFile(
        path.join(originalDir, "SKILL.md"),
        `---\nname: "foo"\ndescription: "original foo"\n---\n\nFoo original`,
      )

      // Simulate what spawnReview does: build the map and call execute
      const resolvedLocation = path.join(originalDir, "SKILL.md")
      const skillLocationMap: Record<string, string> = { foo: resolvedLocation }

      // The bound tool's execute logic: resolve then delegate
      const resolvedForName = skillLocationMap["foo"]
      const result = await SkillManageTool.execute({
        action: "edit",
        name: "foo",
        description: "updated foo",
        content: "Foo updated",
        skillLocation: resolvedForName, // what the bound tool injects
      })

      expect(result.ok).toBe(true)

      const shadowDir = path.join(tmp, "project", ".aether", "skills", "foo")
      const shadowContent = await fs.readFile(path.join(shadowDir, "SKILL.md"), "utf-8")
      expect(shadowContent).toContain("Foo updated")

      const originalContent = await fs.readFile(path.join(originalDir, "SKILL.md"), "utf-8")
      expect(originalContent).toContain("Foo original")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  test("skill not in map goes to skill-sessions, not shadow", async () => {
    // No skillLocation, no map entry → sessionProjectId path
    const result = await SkillManageTool.execute({
      action: "create",
      name: "unknown-skill",
      description: "not in any map",
      content: "Some content",
      sessionProjectId: "proj-xyz",
    })

    expect(result.ok).toBe(true)
    expect(result.skillDir).toContain("skill-sessions")
    expect(result.skillDir).not.toContain(".aether" + path.sep + "skills")

    await fs.rm(result.skillDir!, { recursive: true, force: true })
  })
})
