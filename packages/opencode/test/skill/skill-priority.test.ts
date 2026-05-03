import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill"
import { tmpdir } from "../fixture/fixture"

const SKILL_NAME = "conflict-skill"

async function mkSkill(dir: string, description: string) {
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(
    path.join(dir, "SKILL.md"),
    `---
name: ${SKILL_NAME}
description: ${description}
---
`,
  )
}

afterEach(async () => {
  await Instance.disposeAll()
})

async function winner(projectDir: string): Promise<string | undefined> {
  return Instance.provide({
    directory: projectDir,
    fn: async () => {
      const skill = (await Skill.all()).find((s) => s.name === SKILL_NAME)
      return skill?.description
    },
  })
}

// ─── same parent dir ─────────────────────────────────────────────────────────

describe("same parent dir: .aether > .opencode > .claude > .agents", () => {
  test(".aether beats .opencode", async () => {
    await using tmp = await tmpdir({ git: true })
    await mkSkill(path.join(tmp.path, ".opencode", "skills", SKILL_NAME), "from .opencode")
    await mkSkill(path.join(tmp.path, ".aether", "skills", SKILL_NAME), "from .aether")
    expect(await winner(tmp.path)).toBe("from .aether")
  })

  test(".aether beats .claude", async () => {
    await using tmp = await tmpdir({ git: true })
    await mkSkill(path.join(tmp.path, ".claude", "skills", SKILL_NAME), "from .claude")
    await mkSkill(path.join(tmp.path, ".aether", "skills", SKILL_NAME), "from .aether")
    expect(await winner(tmp.path)).toBe("from .aether")
  })

  test(".aether beats .agents", async () => {
    await using tmp = await tmpdir({ git: true })
    await mkSkill(path.join(tmp.path, ".agents", "skills", SKILL_NAME), "from .agents")
    await mkSkill(path.join(tmp.path, ".aether", "skills", SKILL_NAME), "from .aether")
    expect(await winner(tmp.path)).toBe("from .aether")
  })

  test(".opencode beats .claude", async () => {
    await using tmp = await tmpdir({ git: true })
    await mkSkill(path.join(tmp.path, ".claude", "skills", SKILL_NAME), "from .claude")
    await mkSkill(path.join(tmp.path, ".opencode", "skills", SKILL_NAME), "from .opencode")
    expect(await winner(tmp.path)).toBe("from .opencode")
  })

  test(".opencode beats .agents", async () => {
    await using tmp = await tmpdir({ git: true })
    await mkSkill(path.join(tmp.path, ".agents", "skills", SKILL_NAME), "from .agents")
    await mkSkill(path.join(tmp.path, ".opencode", "skills", SKILL_NAME), "from .opencode")
    expect(await winner(tmp.path)).toBe("from .opencode")
  })

  test(".claude beats .agents", async () => {
    await using tmp = await tmpdir({ git: true })
    await mkSkill(path.join(tmp.path, ".agents", "skills", SKILL_NAME), "from .agents")
    await mkSkill(path.join(tmp.path, ".claude", "skills", SKILL_NAME), "from .claude")
    expect(await winner(tmp.path)).toBe("from .claude")
  })
})

// ─── project > global ────────────────────────────────────────────────────────

describe("project > global", () => {
  test("project .aether beats global .aether", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path
    try {
      await mkSkill(path.join(tmp.path, ".aether", "skills", SKILL_NAME), "from global .aether")
      // project dir is a subdirectory so worktree != directory
      const subdir = path.join(tmp.path, "src")
      await fs.mkdir(subdir, { recursive: true })
      await mkSkill(path.join(subdir, ".aether", "skills", SKILL_NAME), "from project .aether")
      expect(await winner(subdir)).toBe("from project .aether")
    } finally {
      process.env.OPENCODE_TEST_HOME = originalHome
    }
  })

  test("project .claude beats global .aether", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path
    try {
      await mkSkill(path.join(tmp.path, ".aether", "skills", SKILL_NAME), "from global .aether")
      const subdir = path.join(tmp.path, "src")
      await fs.mkdir(subdir, { recursive: true })
      await mkSkill(path.join(subdir, ".claude", "skills", SKILL_NAME), "from project .claude")
      expect(await winner(subdir)).toBe("from project .claude")
    } finally {
      process.env.OPENCODE_TEST_HOME = originalHome
    }
  })

  test("global .aether beats global .claude", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path
    try {
      await mkSkill(path.join(tmp.path, ".claude", "skills", SKILL_NAME), "from global .claude")
      await mkSkill(path.join(tmp.path, ".aether", "skills", SKILL_NAME), "from global .aether")
      expect(await winner(tmp.path)).toBe("from global .aether")
    } finally {
      process.env.OPENCODE_TEST_HOME = originalHome
    }
  })

  test("global .aether beats global .agents", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path
    try {
      await mkSkill(path.join(tmp.path, ".agents", "skills", SKILL_NAME), "from global .agents")
      await mkSkill(path.join(tmp.path, ".aether", "skills", SKILL_NAME), "from global .aether")
      expect(await winner(tmp.path)).toBe("from global .aether")
    } finally {
      process.env.OPENCODE_TEST_HOME = originalHome
    }
  })
})

// ─── project inner > project outer ───────────────────────────────────────────

describe("project inner (directory) > project outer (worktree)", () => {
  test("directory/.aether beats worktree/.aether", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "src")
    await fs.mkdir(subdir, { recursive: true })
    await mkSkill(path.join(tmp.path, ".aether", "skills", SKILL_NAME), "from worktree .aether")
    await mkSkill(path.join(subdir, ".aether", "skills", SKILL_NAME), "from directory .aether")
    expect(await winner(subdir)).toBe("from directory .aether")
  })

  test("directory/.claude beats worktree/.aether", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "src")
    await fs.mkdir(subdir, { recursive: true })
    await mkSkill(path.join(tmp.path, ".aether", "skills", SKILL_NAME), "from worktree .aether")
    await mkSkill(path.join(subdir, ".claude", "skills", SKILL_NAME), "from directory .claude")
    expect(await winner(subdir)).toBe("from directory .claude")
  })
})
