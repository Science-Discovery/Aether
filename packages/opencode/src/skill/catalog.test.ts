import { describe, expect, test } from "bun:test"
import { brief, extractPage, limit, merge, parseCheck, parseFind, queries, splitPackage } from "./catalog"

const FIND = `
\u001b[38;5;102mInstall with\u001b[0m npx skills add <owner/repo@skill>

\u001b[38;5;145myizhiyanhua-ai/skills-updater@skills-updater\u001b[0m \u001b[36m285 installs\u001b[0m
\u001b[38;5;102m└ https://skills.sh/yizhiyanhua-ai/skills-updater/skills-updater\u001b[0m

\u001b[38;5;145mskills.volces.com@auto-updater\u001b[0m \u001b[36m38 installs\u001b[0m
\u001b[38;5;102m└ https://skills.sh/skills.volces.com/auto-updater\u001b[0m
`

const CHECK = `
\u001b[38;5;145m5 update(s) available:\u001b[0m

  \u001b[38;5;145m↑\u001b[0m find-skills
    \u001b[38;5;102msource: vercel-labs/skills\u001b[0m
  \u001b[38;5;145m↑\u001b[0m playwright-cli
    \u001b[38;5;102msource: microsoft/playwright-cli\u001b[0m

\u001b[38;5;102mCould not check 1 skill(s) (may need reinstall)\u001b[0m

  \u001b[38;5;102m✗\u001b[0m humanizer-cn
    \u001b[38;5;102msource: z0gsh1u/oh-my-writing-skill\u001b[0m
`

const SUMMARY = `
<div class="text-xs font-mono uppercase text-(--ds-gray-600) mb-3">Summary</div>
<div>
  <div class="prose">
    <p><strong>Discover and install specialized agent skills from the open ecosystem when users need extended capabilities.</strong></p>
    <ul>
      <li>Helps identify relevant skills by domain and task</li>
      <li>Integrates with the Skills CLI to search and install packages</li>
    </ul>
  </div>
</div>
`

const SKILL = `
<span>SKILL.md</span>
<div class="prose prose-invert max-w-none">
  <h1>Polishing and reviewing research papers in LaTeX</h1>
  <p>This skill helps revise and polish academic manuscripts with tracked changes.</p>
  <h2>When to Use This Skill</h2>
  <p>Use it when a user asks to refine a paper draft.</p>
</div>
`

describe("splitPackage", () => {
  test("splits package and skill names", () => {
    expect(splitPackage("vercel-labs/skills@find-skills")).toEqual({
      source: "vercel-labs/skills",
      skill: "find-skills",
    })
  })

  test("supports domain-like sources", () => {
    expect(splitPackage("skills.volces.com@auto-updater")).toEqual({
      source: "skills.volces.com",
      skill: "auto-updater",
    })
  })
})

describe("parseFind", () => {
  test("parses skills.sh search output", () => {
    expect(parseFind(FIND)).toEqual([
      {
        package: "yizhiyanhua-ai/skills-updater@skills-updater",
        installs: "285",
        source: "yizhiyanhua-ai/skills-updater",
        name: "skills-updater",
        url: "https://skills.sh/yizhiyanhua-ai/skills-updater/skills-updater",
      },
      {
        package: "skills.volces.com@auto-updater",
        installs: "38",
        source: "skills.volces.com",
        name: "auto-updater",
        url: "https://skills.sh/skills.volces.com/auto-updater",
      },
    ])
  })
})

describe("parseCheck", () => {
  test("parses update and failed check entries", () => {
    expect(parseCheck(CHECK)).toEqual({
      updates: {
        "find-skills": "vercel-labs/skills",
        "playwright-cli": "microsoft/playwright-cli",
      },
      failed: {
        "humanizer-cn": "z0gsh1u/oh-my-writing-skill",
      },
    })
  })
})

describe("extractPage", () => {
  test("prefers summary section when present", () => {
    expect(extractPage(SUMMARY)).toEqual({
      text: expect.stringContaining("Discover and install specialized agent skills"),
      source: "skills_summary",
    })
  })

  test("falls back to SKILL.md content", () => {
    expect(extractPage(SKILL)).toEqual({
      text: expect.stringContaining("Polishing and reviewing research papers in LaTeX"),
      source: "skill_md",
    })
  })
})

describe("brief", () => {
  test("prefers video classification over generic editing", () => {
    expect(
      brief({
        id: "blitzreels-video-editing",
        name: "blitzreels-video-editing",
        provider: "external",
        source: "blitzreels/agent-skills",
      }),
    ).toContain("视频或多媒体")
  })

  test("treats copy-editing as proofreading instead of humanizer", () => {
    const out = brief({
      id: "copy-editing",
      name: "copy-editing",
      provider: "external",
      source: "coreyhaines31/marketingskills",
    })
    expect(out).toContain("校对")
    expect(out).not.toContain("真人")
  })

  test("keeps academic paper assistant summaries out of translation buckets", () => {
    const out = brief({
      id: "latex-paper-en",
      name: "latex-paper-en",
      provider: "external",
      source: "local/skills",
      description:
        "English LaTeX academic paper assistant for existing .tex projects. Use this skill whenever the user wants to compile, lint, audit, or improve an English LaTeX conference or journal paper. Trigger even when the user mentions grammar cleanup, translation, title optimization, figure checks, or experiment-section review.",
    })
    expect(out).toContain("学术论文")
    expect(out).not.toContain("翻译")
  })

  test("classifies academic translate skills into manuscript translation buckets", () => {
    const out = brief({
      id: "academic-translate",
      name: "academic-translate",
      provider: "external",
      source: "canyangliunian/agent-skills",
      description: "Translate academic papers and manuscripts while preserving scholarly terminology.",
    })
    expect(out).toContain("翻译")
    expect(out).toContain("学术论文")
    expect(out).not.toContain("代码整理")
  })

  test("classifies academic translate skill_md bodies into translation instead of code buckets", () => {
    const out = brief(
      {
        id: "academic-translate",
        name: "academic-translate",
        provider: "external",
        source: "canyangliunian/agent-skills",
      },
      "学术翻译专家 版本：v2.7 validate-glossary.py 升级 Table Guard 翻译即重写 完整翻译所有内容 学术规范 术语一致性",
    )
    expect(out).toContain("翻译")
    expect(out).toContain("学术论文")
    expect(out).not.toContain("代码整理")
  })

  test("uses conservative generic text for unknown skills", () => {
    expect(
      brief({
        id: "glm-claude",
        name: "glm-claude",
        provider: "external",
        source: "alchaincyf/glm-claude",
      }),
    ).toContain("当前只拿到了基础信息")
  })
})

describe("merge", () => {
  test("prefers exact local hits before semantic and external hits", () => {
    expect(
      merge("auto updater", [
        {
          id: "local-semantic",
          name: "refresh-helper",
          provider: "registry",
          rank: "semantic",
          installed: false,
        },
        {
          id: "external-exact",
          name: "auto-updater",
          provider: "external",
          rank: "exact",
          installed: false,
        },
        {
          id: "local-exact",
          name: "auto updater",
          provider: "registry",
          rank: "exact",
          installed: false,
        },
      ]),
    ).toEqual(["local-exact", "external-exact", "local-semantic"])
  })
})

describe("limit", () => {
  test("falls back when work takes too long", async () => {
    const start = Date.now()
    const result = await limit(25, "fallback", () => new Promise<string>(() => undefined))

    expect(result).toBe("fallback")
    expect(Date.now() - start).toBeLessThan(150)
  })

  test("returns resolved work before timeout", async () => {
    const result = await limit(100, "fallback", async () => "done")
    expect(result).toBe("done")
  })
})

describe("queries", () => {
  test("plans broad english probes for chinese paper polish intent", () => {
    const result = queries("找一下润色论文的skill", {
      phrases: [],
      keywords: [],
    })
    expect(result).toEqual(expect.arrayContaining(["paper polish", "proofread manuscript", "proofread paper"]))
  })

  test("plans broad english probes for scientific visualization intent", () => {
    const result = queries("科研绘图skill", {
      phrases: [],
      keywords: [],
    })
    expect(result).toEqual(expect.arrayContaining(["scientific visualization", "scientific plotting", "figure generation"]))
    expect(result).not.toEqual(expect.arrayContaining(["find skills"]))
  })

  test("keeps explicit meta discovery queries focused on meta tooling", () => {
    const result = queries("找一下搜索和安装skill的工具", {
      phrases: [],
      keywords: [],
    })
    expect(result).toEqual(expect.arrayContaining(["skill discovery"]))
  })
})
