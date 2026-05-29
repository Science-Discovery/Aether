import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { EvolvedSkills } from "./evolved-skills"
import { Spawner } from "./spawner"

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "evolved-skills-test-"))
}

/** Write a SKILL.md with the given frontmatter map + body into <container>/<name>/SKILL.md. */
async function writeSkill(
  container: string,
  name: string,
  meta: Record<string, string>,
  body = "skill body",
): Promise<string> {
  const dir = path.join(container, name)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, "SKILL.md")
  const frontmatter = Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  await fs.writeFile(file, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8")
  return file
}

describe("EvolvedSkills.list", () => {
  test("lists skills from the project .aether/skills container", async () => {
    const root = await tmpRoot()
    const container = path.join(root, ".aether", "skills")
    await writeSkill(container, "alpha", {
      name: "alpha",
      description: "the alpha skill",
      category: "writing",
      enabled: "true",
      evolution_enabled: "false",
    })

    const skills = await EvolvedSkills.list(root, "anyid")
    expect(skills).toHaveLength(1)
    const s = skills[0]!
    expect(s.name).toBe("alpha")
    expect(s.description).toBe("the alpha skill")
    expect(s.category).toBe("writing")
    expect(s.enabled).toBe(true)
    expect(s.evolution_enabled).toBe(false)
    expect(s.content).toContain("skill body")
  })

  test("lists skills from the skill-evolution container keyed by projectId", async () => {
    // skill-evolution dir is global (under Global.Path.data), addressed by projectId.
    const projectId = "evtest" + Date.now().toString(16)
    const seDir = Spawner.skillEvolutionDir(Spawner.skillFolderName("/some/dir", projectId))
    await writeSkill(seDir, "beta", { name: "beta", description: "the beta skill" })
    try {
      const root = await tmpRoot()
      const skills = await EvolvedSkills.list(root, projectId)
      const beta = skills.find((s) => s.name === "beta")
      expect(beta).toBeDefined()
      expect(beta!.description).toBe("the beta skill")
    } finally {
      await fs.rm(Spawner.skillEvolutionBase(Spawner.skillFolderName("/some/dir", projectId)), {
        recursive: true,
        force: true,
      })
    }
  })

  test("falls back to dirname when name frontmatter is missing", async () => {
    const root = await tmpRoot()
    const container = path.join(root, ".aether", "skills")
    await writeSkill(container, "my-folder", { description: "no name field" })
    const skills = await EvolvedSkills.list(root, "anyid")
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe("my-folder")
  })

  test("returns empty array for an empty project directory (boundary)", async () => {
    const root = await tmpRoot()
    const skills = await EvolvedSkills.list(root, "anyid")
    expect(skills).toEqual([])
  })

  test("returns empty array for an empty-string directory (boundary)", async () => {
    const skills = await EvolvedSkills.list("", "anyid")
    expect(skills).toEqual([])
  })
})

describe("EvolvedSkills.toggleEnabled", () => {
  test("flips an existing enabled flag while preserving other frontmatter", async () => {
    const root = await tmpRoot()
    const container = path.join(root, ".aether", "skills")
    const file = await writeSkill(container, "gamma", {
      name: "gamma",
      description: "keep me",
      enabled: "true",
    })

    await EvolvedSkills.toggleEnabled(file, false)

    const after = await fs.readFile(file, "utf8")
    expect(after).toContain("enabled: false")
    expect(after).not.toContain("enabled: true")
    expect(after).toContain("description: keep me")
    expect(after).toContain("name: gamma")
  })

  test("adds the enabled flag when it does not exist yet (boundary)", async () => {
    const root = await tmpRoot()
    const container = path.join(root, ".aether", "skills")
    const file = await writeSkill(container, "delta", { name: "delta", description: "d" })

    await EvolvedSkills.toggleEnabled(file, true)

    const after = await fs.readFile(file, "utf8")
    expect(after).toContain("enabled: true")
    expect(after).toContain("name: delta")
  })
})

describe("EvolvedSkills.toggleEvolution", () => {
  test("flips the evolution_enabled flag", async () => {
    const root = await tmpRoot()
    const container = path.join(root, ".aether", "skills")
    const file = await writeSkill(container, "epsilon", {
      name: "epsilon",
      description: "e",
      evolution_enabled: "true",
    })

    await EvolvedSkills.toggleEvolution(file, false)

    const after = await fs.readFile(file, "utf8")
    expect(after).toContain("evolution_enabled: false")
    expect(after).not.toContain("evolution_enabled: true")
  })
})

describe("EvolvedSkills path safety", () => {
  test("rejects a file outside any evolved-skills container", async () => {
    const root = await tmpRoot()
    const stray = path.join(root, "SKILL.md")
    await fs.writeFile(stray, "---\nname: x\n---\nbody", "utf8")

    await expect(EvolvedSkills.toggleEnabled(stray, true)).rejects.toThrow()
    // file must be untouched
    const after = await fs.readFile(stray, "utf8")
    expect(after).not.toContain("enabled:")
  })

  test("rejects a path that uses .. traversal to escape the container", async () => {
    const root = await tmpRoot()
    const container = path.join(root, ".aether", "skills")
    await fs.mkdir(container, { recursive: true })
    const secret = path.join(root, "secret.md")
    await fs.writeFile(secret, "top secret", "utf8")

    const traversal = path.join(container, "x", "..", "..", "..", "secret.md")
    await expect(EvolvedSkills.toggleEnabled(traversal, true)).rejects.toThrow()
    const after = await fs.readFile(secret, "utf8")
    expect(after).toBe("top secret")
  })

  test("rejects a non-whitelisted container (e.g. plain skills dir, not .aether)", async () => {
    const root = await tmpRoot()
    const dir = path.join(root, "skills", "zeta")
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, "SKILL.md")
    await fs.writeFile(file, "---\nname: zeta\n---\nbody", "utf8")

    await expect(EvolvedSkills.toggleEnabled(file, true)).rejects.toThrow()
  })
})
