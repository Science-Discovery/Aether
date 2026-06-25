import { describe, expect, test, mock } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SkillManageTool, createBoundSkillManageTool } from "./skill-manage-tool"

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

  test("create without skillLocation writes to skill-evolution bucket", async () => {
    const result = await SkillManageTool.execute({
      action: "create",
      name: "brand-new-skill",
      description: "a new skill",
      content: "Do something useful.",
      sessionProjectId: "test-proj-id",
    })

    expect(result.ok).toBe(true)
    expect(result.skillDir).toContain(path.join("skill-evolution", "test-proj-id"))

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

// SKILL_IDENTITY_DESIGN.md 里程碑1: 每个进化 skill 在创建时盖一个稳定唯一 id 进 frontmatter;
// edit 必须保留它(改内容不改身份)。id 是后续"按 id 认人、不按名字"的根。
function readId(content: string): string | null {
  const m = content.match(/^id:\s*(.+)$/m)
  if (!m) return null
  return m[1].trim().replace(/^['"]|['"]$/g, "")
}

describe("SkillManageTool stamps a stable unique id", () => {
  // A1: create → frontmatter 有非空 id(带 skl_ 前缀)
  test("create stamps a non-empty skl_ id into frontmatter", async () => {
    const result = await SkillManageTool.execute({
      action: "create",
      name: "id-skill-a",
      description: "d",
      content: "body",
      sessionProjectId: "test-id-proj",
    })
    try {
      expect(result.ok).toBe(true)
      const content = await fs.readFile(path.join(result.skillDir!, "SKILL.md"), "utf-8")
      const id = readId(content)
      expect(id).not.toBeNull()
      expect(id!.startsWith("skl_")).toBe(true)
      expect(id!.length).toBeGreaterThan("skl_".length)
    } finally {
      if (result.skillDir) await fs.rm(result.skillDir, { recursive: true, force: true })
    }
  })

  // A3: 两次 create(哪怕同设置)→ id 不同
  test("two creates get different ids", async () => {
    const r1 = await SkillManageTool.execute({
      action: "create", name: "id-skill-x", description: "d", content: "b", sessionProjectId: "test-id-proj",
    })
    const r2 = await SkillManageTool.execute({
      action: "create", name: "id-skill-y", description: "d", content: "b", sessionProjectId: "test-id-proj",
    })
    try {
      const id1 = readId(await fs.readFile(path.join(r1.skillDir!, "SKILL.md"), "utf-8"))
      const id2 = readId(await fs.readFile(path.join(r2.skillDir!, "SKILL.md"), "utf-8"))
      expect(id1).not.toBeNull()
      expect(id2).not.toBeNull()
      expect(id1).not.toBe(id2)
    } finally {
      if (r1.skillDir) await fs.rm(r1.skillDir, { recursive: true, force: true })
      if (r2.skillDir) await fs.rm(r2.skillDir, { recursive: true, force: true })
    }
  })

  // A2: edit 保留已有 id(改内容不改身份)
  test("edit preserves an existing id", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-id-keep-"))
    try {
      const originalDir = path.join(tmp, "project", ".claude", "skills", "id-keep")
      await fs.mkdir(originalDir, { recursive: true })
      await fs.writeFile(
        path.join(originalDir, "SKILL.md"),
        `---\nid: "skl_keepme123"\nname: "id-keep"\ndescription: "orig"\n---\n\nOriginal body`,
      )

      const result = await SkillManageTool.execute({
        action: "edit",
        name: "id-keep",
        description: "updated",
        content: "Updated body",
        skillLocation: path.join(originalDir, "SKILL.md"),
      })
      expect(result.ok).toBe(true)

      const content = await fs.readFile(path.join(result.skillDir!, "SKILL.md"), "utf-8")
      expect(readId(content)).toBe("skl_keepme123") // id 不变
      expect(content).toContain("Updated body") // 内容已改
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
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

  test("skill not in map goes to skill-evolution, not shadow", async () => {
    // No skillLocation, no map entry → sessionProjectId path
    const result = await SkillManageTool.execute({
      action: "create",
      name: "unknown-skill",
      description: "not in any map",
      content: "Some content",
      sessionProjectId: "proj-xyz",
    })

    expect(result.ok).toBe(true)
    expect(result.skillDir).toContain("skill-evolution")
    expect(result.skillDir).not.toContain(".aether" + path.sep + "skills")

    await fs.rm(result.skillDir!, { recursive: true, force: true })
  })
})

describe("SkillManageTool self-evolution lock (hard floor)", () => {
  test("refuses to edit a skill whose original SKILL.md is in evolutionDisabledFiles; original untouched", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-evolock-test-"))
    try {
      const originalDir = path.join(tmp, "project", ".claude", "skills", "locked")
      await fs.mkdir(originalDir, { recursive: true })
      const skillMd = path.join(originalDir, "SKILL.md")
      await fs.writeFile(skillMd, `---\nname: "locked"\ndescription: "original"\n---\n\nOriginal content`)

      const result = await SkillManageTool.execute(
        {
          action: "edit",
          name: "locked",
          description: "should be blocked",
          content: "Sneaky rewrite",
          skillLocation: skillMd,
        },
        { evolutionDisabledFiles: new Set([path.resolve(skillMd)]) },
      )

      expect(result.ok).toBe(false)
      expect(result.message.toLowerCase()).toContain("self-evolution")

      // Original must be untouched, and no shadow should have been written.
      const original = await fs.readFile(skillMd, "utf-8")
      expect(original).toContain("Original content")
      const shadowDir = path.join(tmp, "project", ".aether", "skills", "locked")
      const shadowExists = await fs.access(shadowDir).then(() => true).catch(() => false)
      expect(shadowExists).toBe(false)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  test("allows edits to a skill not in the lock set (boundary)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-evolock-ok-"))
    try {
      const originalDir = path.join(tmp, "project", ".claude", "skills", "free")
      await fs.mkdir(originalDir, { recursive: true })
      const skillMd = path.join(originalDir, "SKILL.md")
      await fs.writeFile(skillMd, `---\nname: "free"\ndescription: "original"\n---\n\nOriginal content`)

      const result = await SkillManageTool.execute(
        {
          action: "edit",
          name: "free",
          description: "updated",
          content: "Allowed rewrite",
          skillLocation: skillMd,
        },
        { evolutionDisabledFiles: new Set([path.resolve(path.join(tmp, "other", "SKILL.md"))]) },
      )

      expect(result.ok).toBe(true)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  test("bound tool injects the lock set and blocks a locked skill resolved via the location map", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-evolock-bound-"))
    try {
      const originalDir = path.join(tmp, "project", ".opencode", "skills", "boundlocked")
      await fs.mkdir(originalDir, { recursive: true })
      const skillMd = path.join(originalDir, "SKILL.md")
      await fs.writeFile(skillMd, `---\nname: "boundlocked"\ndescription: "o"\n---\n\nOriginal content`)

      const tool = createBoundSkillManageTool(
        "proj-id",
        { boundlocked: skillMd },
        {},
        new Set([path.resolve(skillMd)]),
      )

      // Tool.define returns { id, init }; the executable lives behind init().
      const bound = await tool.init()
      const out = await bound.execute(
        { action: "edit", name: "boundlocked", description: "x", content: "blocked" } as any,
        {} as any,
      )

      expect(out.metadata.ok).toBe(false)
      const original = await fs.readFile(skillMd, "utf-8")
      expect(original).toContain("Original content")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
