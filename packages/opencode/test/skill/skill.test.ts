import { afterEach, test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { Config } from "../../src/config/config"

afterEach(async () => {
  await Instance.disposeAll()
})

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

test("ignores skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "test-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.find((s) => s.name === "test-skill")).toBeUndefined()
    },
  })
})

test("returns skill directories from Skill.dirs", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skills", "dir-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
`,
      )
    },
  })

  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const dirs = await Skill.dirs()
        const skillDir = path.join(tmp.path, ".opencode", "skills", "dir-skill")
        expect(dirs).toContain(skillDir)
        expect(dirs.length).toBe(1)
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})

test("ignores multiple skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir1 = path.join(dir, ".opencode", "skill", "skill-one")
      const skillDir2 = path.join(dir, ".opencode", "skill", "skill-two")
      await Bun.write(
        path.join(skillDir1, "SKILL.md"),
        `---
name: skill-one
description: First test skill.
---

# Skill One
`,
      )
      await Bun.write(
        path.join(skillDir2, "SKILL.md"),
        `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.find((s) => s.name === "skill-one")).toBeUndefined()
      expect(skills.find((s) => s.name === "skill-two")).toBeUndefined()
    },
  })
})

test("skips skills with missing frontmatter", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skills", "no-frontmatter")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `# No Frontmatter

Just some content without YAML frontmatter.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills).toEqual([])
    },
  })
})

test("discovers skills from .claude/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      const claudeSkill = skills.find((s) => s.name === "claude-skill")
      expect(claudeSkill).toBeDefined()
      expect(claudeSkill!.location).toContain(path.join(".claude", "skills", "claude-skill", "SKILL.md"))
    },
  })
})

test("discovers global skills from ~/.claude/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await createGlobalSkill(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-test-skill")
        expect(skills[0].description).toBe("A global skill from ~/.claude/skills for testing.")
        expect(skills[0].location).toContain(path.join(".claude", "skills", "global-test-skill", "SKILL.md"))
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

test("returns empty array when no skills exist", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills).toEqual([])
    },
  })
})

test("discovers skills from .agents/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".agents", "skills", "agent-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      const agentSkill = skills.find((s) => s.name === "agent-skill")
      expect(agentSkill).toBeDefined()
      expect(agentSkill!.location).toContain(path.join(".agents", "skills", "agent-skill", "SKILL.md"))
    },
  })
})

test("discovers global skills from ~/.agents/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    const skillDir = path.join(tmp.path, ".agents", "skills", "global-agent-skill")
    await fs.mkdir(skillDir, { recursive: true })
    await Bun.write(
      path.join(skillDir, "SKILL.md"),
      `---
name: global-agent-skill
description: A global skill from ~/.agents/skills for testing.
---

# Global Agent Skill

This skill is loaded from the global home directory.
`,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-agent-skill")
        expect(skills[0].description).toBe("A global skill from ~/.agents/skills for testing.")
        expect(skills[0].location).toContain(path.join(".agents", "skills", "global-agent-skill", "SKILL.md"))
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

test("discovers skills from both .claude/skills/ and .agents/skills/", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const claudeDir = path.join(dir, ".claude", "skills", "claude-skill")
      const agentDir = path.join(dir, ".agents", "skills", "agent-skill")
      await Bun.write(
        path.join(claudeDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
      await Bun.write(
        path.join(agentDir, "SKILL.md"),
        `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(2)
      expect(skills.find((s) => s.name === "claude-skill")).toBeDefined()
      expect(skills.find((s) => s.name === "agent-skill")).toBeDefined()
    },
  })
})

test("properly resolves directories that skills live in", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const opencodeSkillDir = path.join(dir, ".opencode", "skill", "ignored-skill")
      const opencodeSkillsDir = path.join(dir, ".opencode", "skills", "agent-skill")
      const claudeDir = path.join(dir, ".claude", "skills", "claude-skill")
      const agentDir = path.join(dir, ".agents", "skills", "agent-skill")
      await Bun.write(
        path.join(claudeDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
      await Bun.write(
        path.join(agentDir, "SKILL.md"),
        `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
      )
      await Bun.write(
        path.join(opencodeSkillDir, "SKILL.md"),
        `---
name: opencode-skill
description: A skill in the .opencode/skill directory.
---

# OpenCode Skill
`,
      )
      await Bun.write(
        path.join(opencodeSkillsDir, "SKILL.md"),
        `---
name: opencode-skill
description: A skill in the .opencode/skills directory.
---

# OpenCode Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dirs = await Skill.dirs()
      const opencodeSkillDir = path.join(tmp.path, ".opencode", "skill", "ignored-skill")
      const opencodeSkillsDir = path.join(tmp.path, ".opencode", "skills", "agent-skill")
      expect(dirs).not.toContain(opencodeSkillDir)
      expect(dirs).toContain(opencodeSkillsDir)
      expect(dirs.length).toBe(3)
    },
  })
})

test("discovers skills from Global.Path.config skills directory", async () => {
  await using tmp = await tmpdir({ git: true })
  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = path.join(tmp.path, "config")
  Config.global.reset()

  try {
    await Bun.write(
      path.join(Global.Path.config, "skills", "config-skill", "SKILL.md"),
      `---
name: config-skill
description: A skill in the global config skills directory.
---

# Config Skill
`,
    )
    await Bun.write(
      path.join(Global.Path.config, "skill", "ignored-config-skill", "SKILL.md"),
      `---
name: ignored-config-skill
description: A skill in the ignored global config skill directory.
---

# Ignored Config Skill
`,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.find((s) => s.name === "config-skill")).toBeDefined()
        expect(skills.find((s) => s.name === "ignored-config-skill")).toBeUndefined()
      },
    })
  } finally {
    await Instance.disposeAll()
    ;(Global.Path as { config: string }).config = prev
    Config.global.reset()
  }
})

test("discovers skills from OPENCODE_CONFIG_DIR skills directory", async () => {
  await using tmp = await tmpdir({ git: true })
  const prev = process.env.OPENCODE_CONFIG_DIR
  const dir = path.join(tmp.path, "profile")
  process.env.OPENCODE_CONFIG_DIR = dir
  Config.global.reset()

  try {
    await Bun.write(
      path.join(dir, "skills", "profile-skill", "SKILL.md"),
      `---
name: profile-skill
description: A skill in the config dir skills directory.
---

# Profile Skill
`,
    )
    await Bun.write(
      path.join(dir, "skill", "ignored-profile-skill", "SKILL.md"),
      `---
name: ignored-profile-skill
description: A skill in the ignored config dir skill directory.
---

# Ignored Profile Skill
`,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.find((s) => s.name === "profile-skill")).toBeDefined()
        expect(skills.find((s) => s.name === "ignored-profile-skill")).toBeUndefined()
      },
    })
  } finally {
    await Instance.disposeAll()
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prev
    Config.global.reset()
  }
})

test("discovers skills from binary config roots", async () => {
  await using tmp = await tmpdir({ git: true })
  const prev = process.execPath
  Object.defineProperty(process, "execPath", { value: path.join(tmp.path, "bin", "aether"), configurable: true })

  try {
    await Bun.write(
      path.join(tmp.path, "bin", ".aether", "skills", "binary-skill", "SKILL.md"),
      `---
name: binary-skill
description: A skill next to the binary.
---

# Binary Skill
`,
    )
    await Bun.write(
      path.join(tmp.path, "bin", ".aether", "skill", "ignored-binary-skill", "SKILL.md"),
      `---
name: ignored-binary-skill
description: A skill in the ignored binary skill directory.
---

# Ignored Binary Skill
`,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.find((s) => s.name === "binary-skill")).toBeDefined()
        expect(skills.find((s) => s.name === "ignored-binary-skill")).toBeUndefined()
      },
    })
  } finally {
    await Instance.disposeAll()
    Object.defineProperty(process, "execPath", { value: prev, configurable: true })
  }
})

test("returns live skill scan sources in priority order", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      skills: {
        paths: ["team-skills"],
      },
    },
    init: async (dir) => {
      await Promise.all(
        [".agents", ".claude", ".opencode", ".aether", "team-skills"].map((name) =>
          fs.mkdir(path.join(dir, name), { recursive: true }),
        ),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const srcs = await Skill.sources()
      const local = srcs
        .filter((item) => item.dir.startsWith(tmp.path))
        .map((item) => `${path.relative(tmp.path, item.dir)}:${item.pattern}`)

      expect(local).toEqual([
        ".agents:skills/**/SKILL.md",
        ".claude:skills/**/SKILL.md",
        ".opencode:skills/**/SKILL.md",
        ".aether:skills/**/SKILL.md",
        `team-skills:**/SKILL.md`,
      ])
    },
  })
})
