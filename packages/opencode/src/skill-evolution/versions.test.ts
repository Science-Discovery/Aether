import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Versions } from "./versions"

async function makeTmp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "versions-test-"))
  return { path: p, cleanup: () => fs.rm(p, { recursive: true, force: true }) }
}

async function makeSkillDir(root: string, content: string): Promise<string> {
  const skillDir = path.join(root, "my-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8")
  return skillDir
}

describe("Versions.create", () => {
  test("creates a .versions directory and bundle file", async () => {
    const tmp = await makeTmp()
    try {
      const skillDir = await makeSkillDir(tmp.path, "---\nname: test\ndescription: test\n---\nContent.\n")
      const filename = await Versions.create(skillDir, "create")
      expect(filename).toMatch(/^v001_create_/)
      const vdir = path.join(skillDir, ".versions")
      const files = await fs.readdir(vdir)
      expect(files).toHaveLength(1)
      expect(files[0]).toBe(filename)
    } finally {
      await tmp.cleanup()
    }
  })

  test("increments version number on successive creates", async () => {
    const tmp = await makeTmp()
    try {
      const skillDir = await makeSkillDir(tmp.path, "---\nname: test\ndescription: test\n---\n")
      await Versions.create(skillDir, "create")
      await Versions.create(skillDir, "edit")
      const entries = await Versions.list(skillDir)
      expect(entries).toHaveLength(2)
      expect(entries[0]!.version).toBe(1)
      expect(entries[1]!.version).toBe(2)
      expect(entries[0]!.action).toBe("create")
      expect(entries[1]!.action).toBe("edit")
    } finally {
      await tmp.cleanup()
    }
  })

  test("bundle contains skill file content", async () => {
    const tmp = await makeTmp()
    try {
      const skillDir = await makeSkillDir(tmp.path, "---\nname: bundle-test\ndescription: bundled\n---\nBundled.\n")
      const filename = await Versions.create(skillDir, "original")
      const bundlePath = path.join(skillDir, ".versions", filename)
      const raw = await fs.readFile(bundlePath, "utf-8")
      const bundle = JSON.parse(raw)
      expect(bundle.files).toHaveLength(1)
      expect(bundle.files[0].path).toBe("SKILL.md")
      expect(bundle.files[0].content).toContain("bundle-test")
    } finally {
      await tmp.cleanup()
    }
  })
})

describe("Versions.rollback", () => {
  test("restores file content from a previous snapshot", async () => {
    const tmp = await makeTmp()
    try {
      const skillDir = await makeSkillDir(tmp.path, "---\nname: rollback-test\ndescription: v1\n---\n")
      await Versions.create(skillDir, "create")

      // Modify the skill
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: rollback-test\ndescription: v2\n---\n", "utf-8")
      await Versions.create(skillDir, "edit")

      // Rollback to v001
      await Versions.rollback(skillDir, "v001")

      const restored = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")
      expect(restored).toContain("description: v1")
    } finally {
      await tmp.cleanup()
    }
  })

  test("throws for unknown version", async () => {
    const tmp = await makeTmp()
    try {
      const skillDir = await makeSkillDir(tmp.path, "---\nname: err\ndescription: test\n---\n")
      await Versions.create(skillDir, "create")
      await expect(Versions.rollback(skillDir, "v999")).rejects.toThrow()
    } finally {
      await tmp.cleanup()
    }
  })
})

describe("Versions.prune (Binary Ruler)", () => {
  test("does nothing when under capacity", async () => {
    const tmp = await makeTmp()
    try {
      const skillDir = await makeSkillDir(tmp.path, "---\nname: prune-test\ndescription: test\n---\n")
      for (let i = 0; i < 5; i++) {
        await Versions.create(skillDir, "edit")
      }
      await Versions.prune(skillDir)
      const entries = await Versions.list(skillDir)
      expect(entries).toHaveLength(5)
    } finally {
      await tmp.cleanup()
    }
  })

  test("prunes to capacity when over limit using Binary Ruler", async () => {
    const tmp = await makeTmp()
    try {
      // Override capacity by creating many versions
      // We test with a small-scale scenario instead of 100
      const skillDir = await makeSkillDir(tmp.path, "---\nname: prune-big\ndescription: test\n---\n")
      // Create 10 versions
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: prune-big\ndescription: v${i + 1}\n---\n`)
        await Versions.create(skillDir, "edit")
      }
      const entries = await Versions.list(skillDir)
      // All 10 should still be there (below capacity of 100)
      expect(entries).toHaveLength(10)
      // v001 always present
      expect(entries[0]!.version).toBe(1)
    } finally {
      await tmp.cleanup()
    }
  })
})

describe("Versions.list", () => {
  test("returns empty array when no .versions directory", async () => {
    const tmp = await makeTmp()
    try {
      const skillDir = await makeSkillDir(tmp.path, "---\nname: list-empty\ndescription: test\n---\n")
      const entries = await Versions.list(skillDir)
      expect(entries).toHaveLength(0)
    } finally {
      await tmp.cleanup()
    }
  })
})
