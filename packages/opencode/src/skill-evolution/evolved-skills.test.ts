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
