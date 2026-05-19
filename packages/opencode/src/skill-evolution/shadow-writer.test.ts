import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@/global"
import { ShadowWriter } from "./shadow-writer"

describe("ShadowWriter.resolveSkillDir", () => {
  test("computes shadow dir from .claude location", () => {
    const location = path.join("/home", "user", "my-project", ".claude", "skills", "my-skill", "SKILL.md")
    expect(ShadowWriter.resolveSkillDir("my-skill", location)).toBe(
      path.join("/home", "user", "my-project", ".aether", "skills", "my-skill"),
    )
  })

  test("computes shadow dir from .agents location", () => {
    const location = path.join("/home", "user", "my-project", ".agents", "skills", "my-skill", "SKILL.md")
    expect(ShadowWriter.resolveSkillDir("my-skill", location)).toBe(
      path.join("/home", "user", "my-project", ".aether", "skills", "my-skill"),
    )
  })

  test("computes shadow dir from .opencode location", () => {
    const location = path.join("/project", ".opencode", "skills", "foo", "SKILL.md")
    expect(ShadowWriter.resolveSkillDir("foo", location)).toBe(path.join("/project", ".aether", "skills", "foo"))
  })

  test("computes shadow dir from global ~/.claude location", () => {
    const location = path.join(Global.Path.home, ".claude", "skills", "my-skill", "SKILL.md")
    expect(ShadowWriter.resolveSkillDir("my-skill", location)).toBe(
      path.join(Global.Path.home, ".aether", "skills", "my-skill"),
    )
  })

  test("picks innermost marker when path contains multiple config dir components", () => {
    // .agents (index 5) is inner; .claude (index 2) is outer — should use .agents' parent
    const location = path.join("/home", ".claude", "projects", "my-project", ".agents", "skills", "foo", "SKILL.md")
    expect(ShadowWriter.resolveSkillDir("foo", location)).toBe(
      path.join("/home", ".claude", "projects", "my-project", ".aether", "skills", "foo"),
    )
  })

  test("falls back to skill-sessions dir when sessionProjectId provided and no location", () => {
    const result = ShadowWriter.resolveSkillDir("new-skill", undefined, "proj-abc123")
    expect(result).toBe(
      path.join(Global.Path.home, ".aether", "skill-sessions", "proj-abc123", "skills", "new-skill"),
    )
  })

  test("falls back to ~/.aether/skills when no location and no projectId", () => {
    const result = ShadowWriter.resolveSkillDir("my-skill")
    expect(result).toBe(path.join(Global.Path.home, ".aether", "skills", "my-skill"))
  })
})

describe("ShadowWriter.validateSkillLocation", () => {
  test("accepts valid .claude/skills path", () => {
    expect(ShadowWriter.validateSkillLocation("/project/.claude/skills/foo/SKILL.md")).toBe(true)
  })

  test("accepts valid .agents/skills path", () => {
    expect(ShadowWriter.validateSkillLocation("/project/.agents/skills/foo/SKILL.md")).toBe(true)
  })

  test("accepts valid .opencode/skills path", () => {
    expect(ShadowWriter.validateSkillLocation("/project/.opencode/skills/foo/SKILL.md")).toBe(true)
  })

  test("accepts valid .aether/skills path", () => {
    expect(ShadowWriter.validateSkillLocation("/project/.aether/skills/foo/SKILL.md")).toBe(true)
  })

  test("rejects path with no config marker", () => {
    expect(ShadowWriter.validateSkillLocation("/home/user/.ssh/id_rsa")).toBe(false)
  })

  test("rejects config marker not followed by skills", () => {
    expect(ShadowWriter.validateSkillLocation("/project/.claude/config/foo/SKILL.md")).toBe(false)
  })

  test("rejects path traversal resolved outside skills dir", () => {
    // path.resolve normalises away the .. so this resolves to something without a valid marker/skills pair
    expect(ShadowWriter.validateSkillLocation("/project/.claude/skills/../../.ssh/id_rsa")).toBe(false)
  })
})

describe("ShadowWriter.copyToShadowIfNeeded", () => {
  test("copies original dir to shadow when shadow does not exist", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-test-"))
    try {
      const original = path.join(tmp, "original")
      const shadow = path.join(tmp, "shadow")
      await fs.mkdir(original, { recursive: true })
      await fs.writeFile(path.join(original, "SKILL.md"), "---\nname: test\ndescription: test skill\n---\n")
      await fs.writeFile(path.join(original, "helper.sh"), "#!/bin/sh\necho hello")

      await ShadowWriter.copyToShadowIfNeeded(original, shadow)

      const shadowContent = await fs.readFile(path.join(shadow, "SKILL.md"), "utf-8")
      expect(shadowContent).toContain("name: test")
      const helperContent = await fs.readFile(path.join(shadow, "helper.sh"), "utf-8")
      expect(helperContent).toContain("echo hello")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  test("does nothing when shadow already exists", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-test-"))
    try {
      const original = path.join(tmp, "original")
      const shadow = path.join(tmp, "shadow")
      await fs.mkdir(original, { recursive: true })
      await fs.writeFile(path.join(original, "SKILL.md"), "---\nname: original\ndescription: original\n---\n")
      await fs.mkdir(shadow, { recursive: true })
      await fs.writeFile(path.join(shadow, "SKILL.md"), "---\nname: evolved\ndescription: evolved\n---\n")

      await ShadowWriter.copyToShadowIfNeeded(original, shadow)

      // Shadow file should remain unchanged
      const shadowContent = await fs.readFile(path.join(shadow, "SKILL.md"), "utf-8")
      expect(shadowContent).toContain("name: evolved")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
