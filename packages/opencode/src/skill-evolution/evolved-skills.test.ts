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
    })

    const skills = await EvolvedSkills.list(root, "anyid")
    expect(skills).toHaveLength(1)
    const s = skills[0]!
    expect(s.name).toBe("alpha")
    expect(s.description).toBe("the alpha skill")
    expect(s.category).toBe("writing")
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

describe("EvolvedSkills.evolutionDirs", () => {
  test("resolves each folder name back to its real project path via the lookup", async () => {
    const root = await tmpRoot()
    await fs.mkdir(path.join(root, "aaa111"), { recursive: true })
    await fs.mkdir(path.join(root, "bbb222"), { recursive: true })
    // folder name === projectId; lookup maps it back to the real worktree.
    const lookup = (id: string) => (id === "aaa111" ? "/home/u/code/test" : undefined)

    const out = await EvolvedSkills.evolutionDirs(root, lookup)

    expect(out).toEqual([
      {
        directory: path.join(root, "aaa111"),
        evolutionDir: path.join(root, "aaa111"),
        projectPath: "/home/u/code/test",
      },
      {
        // bbb222 has no persisted project db → projectPath stays undefined.
        directory: path.join(root, "bbb222"),
        evolutionDir: path.join(root, "bbb222"),
        projectPath: undefined,
      },
    ])
  })

  test("skips the reserved shared/ and logs/ folders and any non-directory entries", async () => {
    const root = await tmpRoot()
    await fs.mkdir(path.join(root, "proj"), { recursive: true })
    await fs.mkdir(path.join(root, "shared"), { recursive: true })
    await fs.mkdir(path.join(root, "logs"), { recursive: true })
    await fs.writeFile(path.join(root, "logs.txt"), "not a project")

    const out = await EvolvedSkills.evolutionDirs(root)

    expect(out.map((d) => d.evolutionDir)).toEqual([path.join(root, "proj")])
  })

  test("returns empty array when the root does not exist (boundary)", async () => {
    const out = await EvolvedSkills.evolutionDirs(path.join(os.tmpdir(), "evolved-skills-does-not-exist-xyz"))
    expect(out).toEqual([])
  })

  test("returns empty array when the root is empty (boundary)", async () => {
    const root = await tmpRoot()
    const out = await EvolvedSkills.evolutionDirs(root)
    expect(out).toEqual([])
  })
})
