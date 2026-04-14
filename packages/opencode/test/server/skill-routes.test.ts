import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import * as AI from "ai"
import { Instance } from "../../src/project/instance"
import { resetForTest } from "../../src/skill/catalog"
import { Process } from "../../src/util/process"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const root = "https://skills.test/.well-known/skills/"
const fixture = path.join(import.meta.dir, "../fixture/skills")
const originalFetch = globalThis.fetch
let textSpy: ReturnType<typeof spyOn> | undefined
let runSpy: ReturnType<typeof spyOn> | undefined
let disposeSpy: ReturnType<typeof spyOn> | undefined
let objSpy: ReturnType<typeof spyOn> | undefined

async function addGlobal(home: string, name: string, description: string, body?: string) {
  const dir = path.join(home, ".agents", "skills", name)
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

# ${name}

${body ?? description}
`,
  )
}

function wait() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function jobs(app: ReturnType<typeof Server.Default>, dir: string, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const out = await (await app.request("/skill/jobs", {
      headers: {
        "x-opencode-directory": dir,
      },
    })).json()
    if (
      out.some((item: { id: string; status: string }) => item.id === "one/repo@first" && item.status === "success") &&
      out.some((item: { id: string; status: string }) => item.id === "three/repo@third" && item.status === "running")
    ) {
      return out
    }
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error("install jobs did not reach expected state in time")
}

afterEach(async () => {
  resetForTest()
  await resetDatabase()
  textSpy?.mockRestore()
  runSpy?.mockRestore()
  disposeSpy?.mockRestore()
  objSpy?.mockRestore()
  textSpy = undefined
  runSpy = undefined
  disposeSpy = undefined
  objSpy = undefined
  globalThis.fetch = originalFetch
})

describe("skill routes", () => {
  test("exact local installed search returns global skills without external lookup", async () => {
    await using tmp = await tmpdir({ config: {} })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "playwright-cli",
        "Automate browser interactions, inspect pages, and run UI checks.",
      )
      textSpy = spyOn(Process, "text").mockResolvedValue({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        text: "",
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "playwright-cli",
          semantic: false,
        }),
      })

      expect(search.status).toBe(200)
      expect(await search.json()).toEqual(
        expect.objectContaining({
          main: expect.arrayContaining([
            expect.objectContaining({
              name: "playwright-cli",
              provider: "external",
              installed: true,
              scope: "global",
              tier: "main",
            }),
          ]),
          meta: expect.objectContaining({
            local: expect.objectContaining({ status: "success" }),
            external: expect.objectContaining({ status: "pending" }),
          }),
        }),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic local installed search matches skill descriptions", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "humanizer",
        "Rewrite text so it sounds more natural, human, and less AI-generated.",
      )
      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "make writing sound more human",
              domain: "writing",
              action: "humanize",
              artifact: "writing",
              tags: ["writing", "humanize"],
              probes: ["humanize writing", "natural writing"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "humanizer",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配让写作更自然的目标。",
                summary_zh: "用于让文本更自然、更像人类写作。",
              },
            ],
          },
        }
      }) as any)
      textSpy = spyOn(Process, "text").mockResolvedValue({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        text: "",
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "make writing sound more human",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      expect(await search.json()).toEqual(
        expect.objectContaining({
          main: expect.arrayContaining([
            expect.objectContaining({
              name: "humanizer",
              provider: "external",
              installed: true,
              scope: "global",
              tier: "main",
            }),
          ]),
          meta: expect.objectContaining({
            local: expect.objectContaining({ status: "success" }),
          }),
        }),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic tool search does not surface unrelated local skills when external lookup fails", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "matlab",
        "MATLAB and GNU Octave numerical computing for matrix operations, data analysis, visualization, and scientific computing.",
        [
          "Use this skill for MATLAB and Octave scripts.",
          "",
          "Install GNU Octave:",
          "sudo apt install octave",
          "",
          "Search matrix examples in the references when you need them.",
        ].join("\n"),
      )
      textSpy = spyOn(Process, "text").mockResolvedValue({
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("network down"),
        text: "",
      })
      globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "auto updater",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      expect(await search.json()).toEqual(
        expect.objectContaining({
          main: [],
          more: [],
          meta: expect.objectContaining({
            local: expect.objectContaining({ status: "success", count: 0 }),
            external: expect.objectContaining({ status: "error" }),
          }),
        }),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic search falls back to web skill discovery when cli recall is empty", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    textSpy = spyOn(Process, "text").mockResolvedValue({
      code: 0,
      stdout: Buffer.from("No skills found for \"make html slides for a talk\""),
      stderr: Buffer.alloc(0),
      text: "No skills found for \"make html slides for a talk\"",
    })
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith("https://search.brave.com/search?q=")) {
        return new Response(
          `
            <html>
              <body>
                <a href="https://skills.sh/demo/slides/html-slides">HTML Slides</a>
                <a href="https://skills.sh/trending">Trending</a>
              </body>
            </html>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/demo/slides/html-slides") {
        return new Response(
          "Create polished HTML slide decks and presentation pages for talks.",
          { status: 200 },
        )
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch

    const app = Server.Default()
    const search = await app.request("/skill/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        query: "make html slides for a talk",
        semantic: true,
      }),
    })

    expect(search.status).toBe(200)
    expect(await search.json()).toEqual(
      expect.objectContaining({
        main: expect.arrayContaining([
          expect.objectContaining({
            name: "html-slides",
            provider: "external",
            tier: "main",
          }),
        ]),
        meta: expect.objectContaining({
          external: expect.objectContaining({ status: "success" }),
        }),
      }),
    )
  })

  test("semantic search reuses cached external discovery for repeated queries", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Paper polish</h1>
              <p>Polish and revise academic papers in LaTeX format.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "找一下论文润色的skill",
              domain: "academic",
              action: "polish",
              artifact: "manuscript",
              tags: ["academic", "manuscript", "polish"],
              direct: ["paper polish", "professional proofreader", "proofread manuscript", "proofread paper"],
              supporting: ["paper review", "manuscript review"],
              broad: ["academic", "research", "scientific"],
              probes: ["paper polish", "professional proofreader", "proofread manuscript", "proofread paper"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "eyh0602/skillshub@paper-polish",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配论文润色目标。",
                summary_zh: "用于学术论文润色。",
              },
            ],
          },
        }
      }) as any)

      let count = 0
      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        count += 1
        const query = String(cmd.at(-1) ?? "")
        if (query !== "paper polish" && query !== "professional proofreader" && query !== "proofread manuscript" && query !== "proofread paper") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        if (query !== "paper polish") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            eyh0602/skillshub@paper-polish 120 installs
            └ https://skills.sh/eyh0602/skillshub/paper-polish
          `,
        }
      })

      const app = Server.Default()
      const first = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "找一下论文润色的skill",
          semantic: true,
        }),
      })
      expect(first.status).toBe(200)
      const seen = count

      const second = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "找一下论文润色的skill",
          semantic: true,
        }),
      })
      expect(second.status).toBe(200)
      expect(count).toBe(seen)
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("searches registry results and installs a skill", async () => {
    await using tmp = await tmpdir({
      config: {
        skills: {
          urls: [root],
        },
      },
    })

    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith(root)) return new Response("Not Found", { status: 404 })
      const file = url.slice(root.length)
      const body = await Bun.file(path.join(fixture, file)).arrayBuffer()
      return new Response(body, { status: 200 })
    }) as typeof fetch
    textSpy = spyOn(Process, "text").mockResolvedValue({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      text: "",
    })

    const app = Server.Default()

    const search = await app.request("/skill/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        query: "cloudflare",
        semantic: false,
      }),
    })

    expect(search.status).toBe(200)
    const found = await search.json()
    expect(found.main).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "cloudflare",
          provider: "registry",
          installed: false,
          registry: root,
          tier: "main",
        }),
      ]),
    )
    expect(found.more).toEqual([])

    const installed = await app.request("/skill/installed", {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(installed.status).toBe(200)
    expect(await installed.json()).toEqual([])

    const check = await app.request("/skill/check", {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(check.status).toBe(200)
    expect(await check.json()).toEqual([])
  })

  test("search returns quickly when an exact local hit is already installed", async () => {
    await using tmp = await tmpdir({
      config: {},
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "playwright-cli",
        "Automate browser interactions, inspect pages, and run UI checks.",
      )

      globalThis.fetch = originalFetch
      textSpy = spyOn(Process, "text").mockImplementation(
        (_cmd, opts) =>
          new Promise((_, reject) => {
            opts?.abort?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            })
          }),
      )

      const app = Server.Default()
      const start = Date.now()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "playwright-cli",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      expect(Date.now() - start).toBeLessThan(6_000)
      expect(await search.json()).toEqual(
        expect.objectContaining({
          main: expect.arrayContaining([
            expect.objectContaining({
              name: "playwright-cli",
              installed: true,
              scope: "global",
            }),
          ]),
          meta: expect.objectContaining({
            model: expect.any(String),
            latency_ms: expect.any(Number),
            local: expect.objectContaining({ status: "success" }),
            external: expect.objectContaining({ status: "success" }),
          }),
        }),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic browser intent queries resolve to playwright automation", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "playwright-cli",
        "Automate browser interactions, inspect pages, and run UI checks.",
      )
      globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch
      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "browser automation",
              domain: "browser",
              action: "browser",
              artifact: "web interaction",
              tags: ["browser", "automation"],
              probes: ["browser automation", "web interaction"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "playwright-cli",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配网页交互与自动化目标。",
                summary_zh: "用于自动化浏览器交互与网页检查。",
              },
            ],
          },
        }
      }) as any)
      textSpy = spyOn(Process, "text").mockResolvedValue({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        text: "",
      })

      const app = Server.Default()
      for (const query of ["click through a website automatically", "自动检查网页元素和交互"]) {
        const search = await app.request("/skill/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            query,
            semantic: true,
          }),
        })

        expect(search.status).toBe(200)
        expect(await search.json()).toEqual(
          expect.objectContaining({
            main: expect.arrayContaining([
              expect.objectContaining({
                name: "playwright-cli",
                tier: "main",
              }),
            ]),
          }),
        )
      }
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic search summarizes real skill content and drops low-relevance external hits", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Paper polish</h1>
            <p>Polish and revise academic papers in LaTeX format.</p>
            <p>Use this skill when revising, polishing, or editing an existing manuscript.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/blitzreels/agent-skills/video-editing") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Video editing</h1>
            <p>Edit short-form videos and multimedia clips for publishing workflows.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/vercel-labs/skills/find-skills") {
        return new Response(
          `
          <div class="text-xs font-mono uppercase text-(--ds-gray-600) mb-3">Summary</div>
          <div><div class="prose">
            <p>Discover and install specialized agent skills from the open ecosystem.</p>
          </div></div>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/paulrberg/agent-skills/code-polish") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Code polish</h1>
            <p>Polish and refactor source code for readability and consistency.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch

    textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
      const query = String(cmd.at(-1) ?? "")
      if (!["paper polish", "proofread manuscript", "proofread paper"].includes(query)) {
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: "",
        }
      }
      return {
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        text: `
          eyh0602/skillshub@paper-polish 120 installs
          └ https://skills.sh/eyh0602/skillshub/paper-polish

          blitzreels/agent-skills@video-editing 88 installs
          └ https://skills.sh/blitzreels/agent-skills/video-editing

          paulrberg/agent-skills@code-polish 162 installs
          └ https://skills.sh/paulrberg/agent-skills/code-polish

          oakoss/agent-skills@ui-ux-polish 64 installs
          └ https://skills.sh/oakoss/agent-skills/ui-ux-polish

          vercel-labs/skills@find-skills 999 installs
          └ https://skills.sh/vercel-labs/skills/find-skills
        `,
      }
    })

    const app = Server.Default()
    const search = await app.request("/skill/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        query: "找一下论文润色的skill",
        semantic: true,
      }),
    })

    expect(search.status).toBe(200)
    const body = await search.json()
    expect(body.meta.model).toBe("opencode/qwen3.6-plus-free")
    expect(body.main).toEqual([
      expect.objectContaining({
        id: "eyh0602/skillshub@paper-polish",
        name: "paper-polish",
        provider: "external",
        relevance: "high",
        summary_source: "skill_md",
        summary_zh: expect.stringContaining("论文"),
        why_recommended: expect.stringContaining("目标"),
        tier: "main",
      }),
    ])
    expect(body.main).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oakoss/agent-skills@ui-ux-polish",
        }),
      ]),
    )
    expect(body.more).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oakoss/agent-skills@ui-ux-polish",
        }),
      ]),
    )
  })

  test("semantic chinese paper polish search uses planned english discovery queries", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Paper polish</h1>
            <p>Polish and revise academic papers in LaTeX format.</p>
            <p>Use this skill when revising, polishing, or editing an existing manuscript.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch

    const seen: string[] = []
    textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
      const query = String(cmd.at(-1) ?? "")
      seen.push(query)
      if (query === "paper polish" || query === "proofread manuscript" || query === "proofread paper") {
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            eyh0602/skillshub@paper-polish 120 installs
            └ https://skills.sh/eyh0602/skillshub/paper-polish
          `,
        }
      }
      return {
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        text: "",
      }
    })

    const app = Server.Default()
    const search = await app.request("/skill/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        query: "找一下论文润色的skill",
        semantic: true,
      }),
    })

    expect(search.status).toBe(200)
    expect(await search.json()).toEqual(
      expect.objectContaining({
        main: expect.arrayContaining([
          expect.objectContaining({
            id: "eyh0602/skillshub@paper-polish",
            name: "paper-polish",
            relevance: "high",
            tier: "main",
          }),
        ]),
        meta: expect.objectContaining({
          external: expect.objectContaining({ status: "success" }),
        }),
      }),
    )
    expect(seen).toEqual(expect.arrayContaining(["找一下论文润色的skill", "proofread manuscript"]))
    expect(seen).not.toContain("polish")
  })

  test("external no-results output is classified as successful empty recall", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      textSpy = spyOn(Process, "text").mockResolvedValue({
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('No skills found for "科研绘图"'),
        text: "",
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "科研绘图",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      expect(await search.json()).toEqual(
        expect.objectContaining({
          main: [],
          more: [],
          meta: expect.objectContaining({
            external: expect.objectContaining({ status: "success", count: 0 }),
          }),
        }),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic search keeps paper-polish in main even when proofreader lacks正文", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Paper polish</h1>
            <p>Polish and revise academic papers in LaTeX format.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch

    textSpy = spyOn(Process, "text").mockResolvedValue({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      text: `
        eyh0602/skillshub@paper-polish 120 installs
        └ https://skills.sh/eyh0602/skillshub/paper-polish

        writer/skills@professional-proofreader 88 installs
        └ https://skills.sh/writer/skills/professional-proofreader
      `,
    })

    const app = Server.Default()
    const search = await app.request("/skill/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        query: "找一下论文润色的skill",
        semantic: true,
      }),
    })

    expect(search.status).toBe(200)
    const body = await search.json()
    expect(body.main).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "eyh0602/skillshub@paper-polish",
          tier: "main",
        }),
      ]),
    )
    expect(
      [...body.main, ...body.more].find((item: { id: string; tier?: string }) => item.id === "writer/skills@professional-proofreader")
        ?.tier,
    ).toBeDefined()
  })

  test("semantic discovery prefers external paper polish results over local installed fallbacks", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "humanize-academic-writing",
        "Transform AI-generated academic text into natural, human-like scholarly writing.",
      )
      await addGlobal(
        tmp.path,
        "citation-aware-paper-writing",
        "Write or revise scientific paper text with Zotero-backed draft citations.",
      )

      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Paper polish</h1>
              <p>Polish and revise academic papers in LaTeX format.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (!["paper polish", "proofread manuscript", "proofread paper"].includes(query)) {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            eyh0602/skillshub@paper-polish 120 installs
            └ https://skills.sh/eyh0602/skillshub/paper-polish
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "找一下论文润色的skill",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const body = await search.json()
      expect(body.main[0]).toEqual(
        expect.objectContaining({
          id: "eyh0602/skillshub@paper-polish",
          tier: "main",
        }),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic discovery ranks paper-polish ahead of generic manuscript results", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Paper polish</h1>
            <p>Polish and revise academic papers in LaTeX format.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/mathews-tom/praxis-skills/manuscript-review") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Manuscript review</h1>
            <p>Review manuscripts before submission.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch

    textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
      const query = String(cmd.at(-1) ?? "")
      if (!["paper polish", "proofread manuscript", "proofread paper"].includes(query)) {
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: "",
        }
      }
      return {
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        text: `
          mathews-tom/praxis-skills@manuscript-review 54 installs
          └ https://skills.sh/mathews-tom/praxis-skills/manuscript-review

          eyh0602/skillshub@paper-polish 120 installs
          └ https://skills.sh/eyh0602/skillshub/paper-polish
        `,
      }
    })

    const app = Server.Default()
    const search = await app.request("/skill/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        query: "找一下论文润色的skill",
        semantic: true,
      }),
    })

    expect(search.status).toBe(200)
    const body = await search.json()
    expect(body.main[0]).toEqual(
      expect.objectContaining({
        id: "eyh0602/skillshub@paper-polish",
      }),
    )
  })

  test("semantic search falls back to deterministic task probes when model probes are too broad", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Paper polish</h1>
              <p>Polish and revise academic papers in LaTeX format.</p>
              <p>Use this skill when revising or proofreading a manuscript before submission.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "找一下论文润色的skill",
              domain: "academic",
              action: "polish",
              artifact: "manuscript",
              tags: ["academic", "manuscript", "polish"],
              probes: ["academic", "research", "scientific"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "eyh0602/skillshub@paper-polish",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配论文润色目标。",
                summary_zh: "用于学术论文润色与校对。",
              },
            ],
          },
        }
      }) as any)

      const seen: string[] = []
      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        seen.push(query)
        if (query !== "paper polish" && query !== "proofread manuscript" && query !== "proofread paper") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            eyh0602/skillshub@paper-polish 120 installs
            └ https://skills.sh/eyh0602/skillshub/paper-polish
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "找一下论文润色的skill",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      expect(await search.json()).toEqual(
        expect.objectContaining({
          main: expect.arrayContaining([
            expect.objectContaining({
              id: "eyh0602/skillshub@paper-polish",
              tier: "main",
            }),
          ]),
        }),
      )
      expect(seen.slice(0, 3)).toEqual(expect.arrayContaining(["proofread manuscript"]))
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic search keeps discovery hits returned by successful fallback probes", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/canyangliunian/agent-skills/academic-translate") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Academic translate</h1>
              <p>Translate academic papers and manuscripts while preserving terminology.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "找一下翻译论文的skill",
              domain: "academic",
              action: "translate",
              artifact: "manuscript",
              tags: ["academic", "translate", "manuscript"],
              probes: ["academic", "research", "scientific"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "canyangliunian/agent-skills@academic-translate",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配学术论文翻译目标。",
                summary_zh: "用于学术论文翻译。",
              },
            ],
          },
        }
      }) as any)

      const seen: string[] = []
      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        seen.push(query)
        if (query !== "paper translation" && query !== "manuscript translation") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            canyangliunian/agent-skills@academic-translate 15 installs
            └ https://skills.sh/canyangliunian/agent-skills/academic-translate
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "找一下翻译论文的skill",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      expect(await search.json()).toEqual(
        expect.objectContaining({
          main: expect.arrayContaining([
            expect.objectContaining({
              id: "canyangliunian/agent-skills@academic-translate",
              tier: "main",
            }),
          ]),
        }),
      )
      expect(seen.slice(0, 4)).toEqual(
        expect.arrayContaining(["找一下翻译论文的skill", "manuscript translation"]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic search keeps direct discovery hits even when page fetch is unavailable", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "find a paper polish skill",
              domain: "academic",
              action: "polish",
              artifact: "manuscript",
              tags: ["academic", "manuscript", "polish"],
              probes: ["academic", "research", "scientific"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [],
          },
        }
      }) as any)

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (query !== "paper polish" && query !== "proofread manuscript" && query !== "proofread paper") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            eyh0602/skillshub@paper-polish 120 installs
            └ https://skills.sh/eyh0602/skillshub/paper-polish
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "paper polish skill",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      expect(await search.json()).toEqual(
        expect.objectContaining({
          main: expect.arrayContaining([
            expect.objectContaining({
              id: "eyh0602/skillshub@paper-polish",
              tier: "main",
            }),
          ]),
        }),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic translation prefers direct external hits over installed academic fallback", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "latex-paper-en",
        "Compile, lint, proofread, and improve English LaTeX papers for submission.",
      )

      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/canyangliunian/agent-skills/academic-translate") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Academic translate</h1>
              <p>Translate academic papers and manuscripts while preserving scholarly terminology.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (query !== "paper translation" && query !== "manuscript translation") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            canyangliunian/agent-skills@academic-translate 15 installs
            └ https://skills.sh/canyangliunian/agent-skills/academic-translate
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "translate an academic manuscript",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const body = await search.json()
      expect(body.main).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "canyangliunian/agent-skills@academic-translate" })]),
      )
      expect(body.main).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "latex-paper-en" })]))
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic docs translation keeps installed academic helpers out of main when direct external hits exist", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "latex-paper-en",
        "English LaTeX academic paper assistant for existing .tex projects.",
        "Proofread, polish, review, and improve academic manuscripts in LaTeX.",
      )

      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/belumume/claude-skills/rtl-document-translation") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>RTL Document Translation</h1>
              <p>Translate technical documentation and product documents, including localized output.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        if (url === "https://skills.sh/ywj3493/claude-skills/sync-translations") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Sync Translations</h1>
              <p>Synchronize and maintain translated documentation across locales.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "translate technical docs",
              domain: "documentation",
              action: "translate",
              artifact: "documentation",
              tags: ["docs", "translate"],
              direct: ["technical docs translation", "docs translation", "document translation"],
              supporting: ["technical docs", "documentation"],
              broad: ["translate", "translation"],
              probes: ["technical docs translation", "docs translation", "document translation"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "belumume/claude-skills@rtl-document-translation",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配技术文档翻译目标。",
                summary_zh: "用于技术文档翻译。",
              },
              {
                id: "ywj3493/claude-skills@sync-translations",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配技术文档翻译目标。",
                summary_zh: "用于多语言文档同步。",
              },
            ],
          },
        }
      }) as any)

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (!["technical docs translation", "docs translation", "document translation"].includes(query)) {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            belumume/claude-skills@rtl-document-translation 41 installs
            └ https://skills.sh/belumume/claude-skills/rtl-document-translation

            ywj3493/claude-skills@sync-translations 10 installs
            └ https://skills.sh/ywj3493/claude-skills/sync-translations
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "translate technical docs",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const out = await search.json()
      expect(out).toEqual(
        expect.objectContaining({
          main: expect.arrayContaining([
            expect.objectContaining({
              id: "belumume/claude-skills@rtl-document-translation",
              tier: "main",
            }),
          ]),
        }),
      )
      expect(out.main).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "latex-paper-en",
          }),
        ]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic docs translation falls back to chinese probes when english probes are empty", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/belumume/claude-skills/rtl-document-translation") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>RTL Document Translation</h1>
              <p>Translate technical documentation and API docs into localized Chinese output.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "把 API 文档翻译成本地化中文",
              domain: "documentation",
              action: "translate",
              artifact: "documentation",
              tags: ["docs", "translate"],
              native: ["把 API 文档翻译成本地化中文", "API 文档 翻译"],
              direct: ["technical docs translation", "docs translation", "document translation"],
              supporting: ["technical docs", "documentation"],
              broad: ["translate", "translation"],
              probes: ["technical docs translation", "docs translation", "document translation"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "belumume/claude-skills@rtl-document-translation",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配技术文档翻译目标。",
                summary_zh: "用于技术文档翻译。",
              },
            ],
          },
        }
      }) as any)

      const seen: string[] = []
      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        seen.push(query)
        if (query !== "api 文档 翻译" && query !== "把 api 文档翻译成本地化中文") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            belumume/claude-skills@rtl-document-translation 41 installs
            └ https://skills.sh/belumume/claude-skills/rtl-document-translation
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "把 API 文档翻译成本地化中文",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const out = await search.json()
      expect(out.main).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "belumume/claude-skills@rtl-document-translation",
            tier: "main",
          }),
        ]),
      )
      expect(seen).toEqual(expect.arrayContaining(["把 api 文档翻译成本地化中文"]))
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic manuscript translation keeps review helpers out of main when direct translation hits exist", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/canyangliunian/agent-skills/academic-translate") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Academic translate</h1>
              <p>Translate academic papers and manuscripts while preserving scholarly terminology.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        if (url === "https://skills.sh/review/skills/scientific-manuscript-review") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Scientific manuscript review</h1>
              <p>Review scientific manuscripts, translate academic papers, and improve academic writing quality.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "translate an academic manuscript",
              domain: "academic",
              action: "translate",
              artifact: "manuscript",
              tags: ["academic", "translate", "manuscript"],
              direct: ["paper translation", "manuscript translation", "academic translation"],
              supporting: ["paper review", "manuscript review"],
              broad: ["academic", "research", "scientific"],
              probes: ["paper translation", "manuscript translation", "academic translation"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "canyangliunian/agent-skills@academic-translate",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配学术论文翻译目标。",
                summary_zh: "用于学术论文翻译。",
              },
              {
                id: "review/skills@scientific-manuscript-review",
                relevance: "high",
                role: "supporting",
                why_recommended: "更偏相邻审阅工作流。",
                summary_zh: "用于学术论文审阅。",
              },
            ],
          },
        }
      }) as any)

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (!["paper translation", "manuscript translation", "academic translation"].includes(query)) {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            canyangliunian/agent-skills@academic-translate 15 installs
            └ https://skills.sh/canyangliunian/agent-skills/academic-translate

            review/skills@scientific-manuscript-review 20 installs
            └ https://skills.sh/review/skills/scientific-manuscript-review
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "translate an academic manuscript",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const out = await search.json()
      expect(out).toEqual(
        expect.objectContaining({
          main: expect.arrayContaining([
            expect.objectContaining({
              id: "canyangliunian/agent-skills@academic-translate",
              tier: "main",
            }),
          ]),
          more: expect.arrayContaining([
            expect.objectContaining({
              id: "review/skills@scientific-manuscript-review",
              tier: "more",
            }),
          ]),
        }),
      )
      expect(out.main).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "review/skills@scientific-manuscript-review",
          }),
        ]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic manuscript translation salvages direct external hit into main without page body", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (!head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              items: [
                {
                  id: "canyangliunian/agent-skills@academic-translate",
                  relevance: "high",
                  role: "direct",
                  why_recommended: "直接匹配学术论文翻译目标。",
                  summary_zh: "用于学术论文翻译。",
                },
              ],
            },
          }
        }
        return {
          object: {
            goal: "translate an academic manuscript",
            domain: "academic",
            action: "translate",
            artifact: "manuscript",
            tags: ["academic", "translate", "manuscript"],
            direct: ["paper translation", "manuscript translation", "academic translation"],
            supporting: ["paper review", "manuscript review"],
            broad: ["academic", "research", "scientific"],
            probes: ["paper translation", "manuscript translation", "academic translation"],
            avoid: ["meta"],
            meta: false,
          },
        }
      }) as any)

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (!["paper translation", "manuscript translation", "academic translation"].includes(query)) {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            canyangliunian/agent-skills@academic-translate 15 installs
            └ https://skills.sh/canyangliunian/agent-skills/academic-translate
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "translate an academic manuscript",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const out = await search.json()
      expect(out.main).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "canyangliunian/agent-skills@academic-translate",
            tier: "main",
            why_recommended: expect.stringContaining("翻译"),
            summary_zh: expect.stringContaining("翻译"),
          }),
        ]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic paper polish keeps installed academic fallback out of main when direct external hit exists", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "latex-paper-en",
        "Compile, lint, proofread, and improve English LaTeX papers for submission.",
      )

      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Paper polish</h1>
              <p>Polish and revise academic papers in LaTeX format.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (!["paper polish", "proofread manuscript", "proofread paper"].includes(query)) {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            eyh0602/skillshub@paper-polish 120 installs
            └ https://skills.sh/eyh0602/skillshub/paper-polish
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "paper polish skill",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const body = await search.json()
      expect(body.main).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "eyh0602/skillshub@paper-polish" })]),
      )
      expect(body.main).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "latex-paper-en" })]))
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic manuscript proofreading keeps review helpers out of main when direct proofreading hits exist", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/writer/skills/professional-proofreader") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Professional proofreader</h1>
              <p>Proofread academic manuscripts, improve grammar, and polish English for publication-ready writing.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        if (url === "https://skills.sh/review/skills/manuscript-review") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Manuscript review</h1>
              <p>Review manuscripts, assess structure, and provide editorial feedback before submission.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "帮我找个给英文稿件校对的 skill",
              domain: "academic",
              action: "polish",
              artifact: "manuscript",
              tags: ["academic", "manuscript", "polish"],
              direct: ["professional proofreader", "english proofreading", "proofread manuscript"],
              supporting: ["manuscript review", "paper review"],
              broad: ["academic", "research", "scientific"],
              probes: ["professional proofreader", "english proofreading", "proofread manuscript"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "writer/skills@professional-proofreader",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配英文稿件校对目标。",
                summary_zh: "用于英文学术稿件校对。",
              },
              {
                id: "review/skills@manuscript-review",
                relevance: "medium",
                role: "supporting",
                why_recommended: "更偏相邻审阅工作流。",
                summary_zh: "用于稿件审阅。",
              },
            ],
          },
        }
      }) as any)

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (!["professional proofreader", "english proofreading", "proofread manuscript"].includes(query)) {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            writer/skills@professional-proofreader 14 installs
            └ https://skills.sh/writer/skills/professional-proofreader

            review/skills@manuscript-review 10 installs
            └ https://skills.sh/review/skills/manuscript-review
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "帮我找个给英文稿件校对的 skill",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const out = await search.json()
      expect(out).toEqual(
        expect.objectContaining({
          main: expect.arrayContaining([
            expect.objectContaining({
              id: "writer/skills@professional-proofreader",
              tier: "main",
            }),
          ]),
          more: expect.arrayContaining([
            expect.objectContaining({
              id: "review/skills@manuscript-review",
              tier: "more",
            }),
          ]),
        }),
      )
      expect(out.main).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "review/skills@manuscript-review",
          }),
        ]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic journal polish zh keeps review and conversion helpers out of main when proofreading hits exist", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "tex-to-md",
        "Convert LaTeX paper source into readable Markdown for review, summarization, and downstream editing.",
      )

      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/writer/skills/professional-proofreader") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Professional proofreader</h1>
              <p>Proofread academic manuscripts, improve grammar, and polish English for publication-ready writing.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        if (url === "https://skills.sh/review/skills/scientific-manuscript-review") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Scientific manuscript review</h1>
              <p>Review scientific manuscripts, proofread papers, and improve academic writing quality.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "投稿前润色英文论文",
              domain: "academic",
              action: "polish",
              artifact: "manuscript",
              tags: ["academic", "manuscript", "polish"],
              direct: ["professional proofreader", "english proofreading", "proofread manuscript", "paper polish"],
              supporting: ["manuscript review", "paper review"],
              broad: ["academic", "research", "scientific"],
              probes: ["professional proofreader", "english proofreading", "proofread manuscript", "paper polish"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "writer/skills@professional-proofreader",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配投稿前英文论文校对目标。",
                summary_zh: "用于投稿前英文论文校对。",
              },
              {
                id: "review/skills@scientific-manuscript-review",
                relevance: "medium",
                role: "supporting",
                why_recommended: "更偏相邻审阅工作流。",
                summary_zh: "用于学术论文审阅。",
              },
            ],
          },
        }
      }) as any)

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (!["professional proofreader", "english proofreading", "proofread manuscript", "paper polish"].includes(query)) {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            writer/skills@professional-proofreader 14 installs
            └ https://skills.sh/writer/skills/professional-proofreader

            review/skills@scientific-manuscript-review 10 installs
            └ https://skills.sh/review/skills/scientific-manuscript-review
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "投稿前润色英文论文",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const out = await search.json()
      expect(out).toEqual(
        expect.objectContaining({
          main: expect.arrayContaining([
            expect.objectContaining({
              id: "writer/skills@professional-proofreader",
              tier: "main",
            }),
          ]),
          more: expect.arrayContaining([
            expect.objectContaining({
              id: "review/skills@scientific-manuscript-review",
              tier: "more",
            }),
            expect.objectContaining({
              name: "tex-to-md",
              tier: "more",
            }),
          ]),
        }),
      )
      expect(out.main).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "review/skills@scientific-manuscript-review",
          }),
          expect.objectContaining({
            name: "tex-to-md",
          }),
        ]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic chinese paper polish keeps exact proofreaders in main when paper-polish is absent", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "latex-paper-en",
        "Compile, lint, proofread, and improve English LaTeX papers for submission.",
      )

      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/writer/skills/professional-proofreader") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Professional proofreader</h1>
              <p>Proofread academic manuscripts, improve grammar, and polish English for publication-ready writing.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "找一下论文润色的skill",
              domain: "academic",
              action: "polish",
              artifact: "manuscript",
              tags: ["academic", "manuscript", "polish"],
              direct: ["paper polish", "professional proofreader", "english proofreading"],
              supporting: ["manuscript review", "paper review"],
              broad: ["academic", "research", "scientific"],
              probes: ["paper polish", "professional proofreader", "english proofreading"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "writer/skills@professional-proofreader",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配论文润色与校对目标。",
                summary_zh: "用于学术论文润色与校对。",
              },
            ],
          },
        }
      }) as any)

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (!["paper polish", "professional proofreader", "english proofreading"].includes(query)) {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        if (query === "paper polish") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            writer/skills@professional-proofreader 14 installs
            └ https://skills.sh/writer/skills/professional-proofreader
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "找一下论文润色的skill",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const body = await search.json()
      expect(body.main).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "writer/skills@professional-proofreader",
          }),
        ]),
      )
      expect(body.main).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "latex-paper-en" })]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic chinese paper polish keeps paper-polish recall even when proofreading hits already exist", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/writer/skills/professional-proofreader") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Professional proofreader</h1>
              <p>Proofread academic manuscripts, improve grammar, and polish English for publication-ready writing.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Paper polish</h1>
              <p>Polish and revise academic papers in LaTeX format.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "找一下论文润色的skill",
              domain: "academic",
              action: "polish",
              artifact: "manuscript",
              tags: ["academic", "manuscript", "polish"],
              direct: ["paper polish", "professional proofreader", "proofread manuscript", "proofread paper"],
              supporting: ["paper review", "manuscript review"],
              broad: ["academic", "research", "scientific"],
              probes: ["paper polish", "professional proofreader", "proofread manuscript", "proofread paper"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "writer/skills@professional-proofreader",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配论文润色与校对目标。",
                summary_zh: "用于学术论文润色与校对。",
              },
              {
                id: "eyh0602/skillshub@paper-polish",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配论文润色目标。",
                summary_zh: "用于学术论文润色。",
              },
            ],
          },
        }
      }) as any)

      const seen: string[] = []
      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        seen.push(query)
        if (query === "professional proofreader") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: `
              writer/skills@professional-proofreader 14 installs
              └ https://skills.sh/writer/skills/professional-proofreader
            `,
          }
        }
        if (query === "paper polish") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: `
              eyh0602/skillshub@paper-polish 120 installs
              └ https://skills.sh/eyh0602/skillshub/paper-polish
            `,
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: "",
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "找一下论文润色的skill",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const body = await search.json()
      expect(body.main).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "writer/skills@professional-proofreader" }),
          expect.objectContaining({ id: "eyh0602/skillshub@paper-polish" }),
        ]),
      )
      expect(seen).toContain("paper polish")
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic chinese paper polish collapses paper-polish family noise when canonical and proofreader hits exist", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Paper polish</h1>
              <p>Polish and revise academic papers in LaTeX format.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        if (url === "https://skills.sh/writer/skills/professional-proofreader") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Professional proofreader</h1>
              <p>Proofread academic manuscripts, improve grammar, and polish English for publication-ready writing.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      objSpy = spyOn(AI, "generateObject").mockImplementation((async (input: any) => {
        const head = String(input?.messages?.[0]?.content ?? "")
        if (head.includes("planning a goal-directed skill search")) {
          return {
            object: {
              goal: "找一下论文润色的skill",
              domain: "academic",
              action: "polish",
              artifact: "manuscript",
              tags: ["academic", "manuscript", "polish"],
              direct: ["paper polish", "professional proofreader", "proofread manuscript", "proofread paper"],
              supporting: ["paper review", "manuscript review"],
              broad: ["academic", "research", "scientific"],
              probes: ["paper polish", "professional proofreader", "proofread manuscript", "proofread paper"],
              avoid: ["meta"],
              meta: false,
            },
          }
        }
        return {
          object: {
            items: [
              {
                id: "eyh0602/skillshub@paper-polish",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配论文润色目标。",
                summary_zh: "用于学术论文润色。",
              },
              {
                id: "writer/skills@professional-proofreader",
                relevance: "high",
                role: "direct",
                why_recommended: "直接匹配论文润色与校对目标。",
                summary_zh: "用于学术论文润色与校对。",
              },
              {
                id: "eyh0602/skillshub@paper-polish-workflow",
                relevance: "high",
                role: "direct",
                why_recommended: "配套论文润色工作流。",
                summary_zh: "用于论文润色工作流。",
              },
              {
                id: "eyh0602/skillshub@ppw:translation",
                relevance: "high",
                role: "direct",
                why_recommended: "论文润色配套翻译流程。",
                summary_zh: "用于论文润色配套翻译流程。",
              },
            ],
          },
        }
      }) as any)

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (query !== "paper polish" && query !== "professional proofreader") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        if (query === "professional proofreader") {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: `
              writer/skills@professional-proofreader 14 installs
              └ https://skills.sh/writer/skills/professional-proofreader
            `,
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            eyh0602/skillshub@paper-polish 120 installs
            └ https://skills.sh/eyh0602/skillshub/paper-polish

            eyh0602/skillshub@paper-polish-workflow 98 installs
            └ https://skills.sh/eyh0602/skillshub/paper-polish-workflow

            eyh0602/skillshub@ppw:translation 66 installs
            └ https://skills.sh/eyh0602/skillshub/ppw:translation
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "找一下论文润色的skill",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const body = await search.json()
      expect(body.main).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "eyh0602/skillshub@paper-polish" }),
          expect.objectContaining({ id: "writer/skills@professional-proofreader" }),
        ]),
      )
      expect(body.main).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "eyh0602/skillshub@paper-polish-workflow" }),
          expect.objectContaining({ id: "eyh0602/skillshub@ppw:translation" }),
        ]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic scientific plotting keeps broad academic helpers out of main", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "latex-paper-en",
        "English LaTeX academic paper assistant for existing .tex projects. Use this skill whenever the user wants to compile, lint, audit, or improve an English LaTeX conference or journal paper such as IEEE, ACM, Springer, NeurIPS, or ICML submissions. Trigger even when the user only mentions one paper issue, such as bibliography errors, grammar cleanup, sentence splitting, logic review, expression polishing, translation, title optimization, figure checks, pseudocode review, algorithm block cleanup, de-AI editing, experiment-section review, table structure validation, three-line table generation, abstract structure diagnosis, or journal adaptation.",
      )
      await addGlobal(
        tmp.path,
        "tex-to-md",
        "Convert LaTeX paper source into readable Markdown. Use when working with scientific manuscripts in .tex form and you need a clean Markdown version for LLM reading, summarization, review, or downstream editing. Best for article-style papers, including multi-file projects with figures, equations, and bibliography files.",
      )
      await addGlobal(
        tmp.path,
        "plotly",
        "Create scientific plotting, charting, and interactive data visualization outputs.",
      )

      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/skills/figure-generation") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Figure generation</h1>
              <p>Create scientific figures, plots, and publication-ready charts for research workflows.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        if (url === "https://skills.sh/research/scientific-visualization") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Scientific visualization</h1>
              <p>Build publication-ready scientific figures, charts, and data visualizations.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      textSpy = spyOn(Process, "text").mockImplementation(async (cmd) => {
        const query = String(cmd.at(-1) ?? "")
        if (!["scientific visualization", "scientific plotting", "figure generation"].includes(query)) {
          return {
            code: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            text: "",
          }
        }
        return {
          code: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          text: `
            skills@figure-generation 42 installs
            └ https://skills.sh/skills/figure-generation

            research@scientific-visualization 19 installs
            └ https://skills.sh/research/scientific-visualization
          `,
        }
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "科研绘图skill",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const body = await search.json()
      expect(body.main).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "global:plotly", tier: "main" }),
          expect.objectContaining({ id: "skills@figure-generation", tier: "main" }),
        ]),
      )
      expect(body.main).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "latex-paper-en" }),
          expect.objectContaining({ name: "tex-to-md" }),
        ]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic exact local search keeps broad helpers out of main", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "latex-paper-en",
        "English LaTeX academic paper assistant for existing .tex projects. Use this skill whenever the user wants to compile, lint, audit, or improve an English LaTeX conference or journal paper.",
      )
      await addGlobal(
        tmp.path,
        "tex-to-md",
        "Convert LaTeX paper source into readable Markdown for review, summarization, and downstream editing.",
      )
      await addGlobal(
        tmp.path,
        "humanize-academic-writing",
        "Make academic writing sound more natural while preserving scholarly tone and structure.",
      )
      await addGlobal(
        tmp.path,
        "pandoc",
        "Convert documents between Markdown, DOCX, PDF, HTML, and LaTeX with pandoc.",
      )
      await addGlobal(
        tmp.path,
        "frontend-slides",
        "Build animation-rich HTML presentations and convert decks into web slides.",
      )
      textSpy = spyOn(Process, "text").mockResolvedValue({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        text: "",
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "latex-paper-en",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const body = await search.json()
      expect(body.main).toEqual([expect.objectContaining({ name: "latex-paper-en", tier: "main" })])
      expect(body.main).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "tex-to-md" }),
          expect.objectContaining({ name: "humanize-academic-writing" }),
          expect.objectContaining({ name: "pandoc" }),
          expect.objectContaining({ name: "frontend-slides" }),
        ]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("coarse scientific plotting search keeps broad academic helpers out of main", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "latex-paper-en",
        "English LaTeX academic paper assistant for existing .tex projects. Use this skill whenever the user wants to compile, lint, audit, or improve an English LaTeX conference or journal paper such as IEEE, ACM, Springer, NeurIPS, or ICML submissions. Trigger even when the user only mentions one paper issue, such as bibliography errors, grammar cleanup, sentence splitting, logic review, expression polishing, translation, title optimization, figure checks, pseudocode review, algorithm block cleanup, de-AI editing, experiment-section review, table structure validation, three-line table generation, abstract structure diagnosis, or journal adaptation.",
      )
      await addGlobal(
        tmp.path,
        "tex-to-md",
        "Convert LaTeX paper source into readable Markdown. Use when working with scientific manuscripts in .tex form and you need a clean Markdown version for LLM reading, summarization, review, or downstream editing. Best for article-style papers, including multi-file projects with figures, equations, and bibliography files.",
      )
      await addGlobal(
        tmp.path,
        "plotly",
        "Create scientific plotting, charting, and interactive data visualization outputs.",
      )
      textSpy = spyOn(Process, "text").mockResolvedValue({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        text: "",
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "科研绘图skill",
          semantic: false,
        }),
      })

      expect(search.status).toBe(200)
      const body = await search.json()
      expect(body.main).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "global:plotly", tier: "main" })]),
      )
      expect(body.main).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "latex-paper-en" }),
          expect.objectContaining({ name: "tex-to-md" }),
        ]),
      )
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("semantic updater search keeps updater tools in main and drops unrelated writing skills", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "https://skills.sh/skills.volces.com/auto-updater") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Auto updater</h1>
            <p>Automatically update installed skills and keep local skill sets in sync.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/yizhiyanhua-ai/skills-updater/skills-updater") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Skills updater</h1>
            <p>Check installed skills, detect available updates, and refresh them with the Skills CLI.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/vercel-labs/skills/find-skills") {
        return new Response(
          `
          <div class="text-xs font-mono uppercase text-(--ds-gray-600) mb-3">Summary</div>
          <div><div class="prose">
            <p>Discover and install specialized agent skills from the open ecosystem.</p>
          </div></div>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/writer/skills/humanizer") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Humanizer</h1>
            <p>Rewrite text so it sounds more natural and human.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/eyh0602/skillshub/paper-polish") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Paper polish</h1>
            <p>Polish and revise academic papers in LaTeX format.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch

    textSpy = spyOn(Process, "text").mockResolvedValue({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      text: `
        skills.volces.com@auto-updater 38 installs
        └ https://skills.sh/skills.volces.com/auto-updater

        yizhiyanhua-ai/skills-updater@skills-updater 285 installs
        └ https://skills.sh/yizhiyanhua-ai/skills-updater/skills-updater

        vercel-labs/skills@find-skills 999 installs
        └ https://skills.sh/vercel-labs/skills/find-skills

        writer/skills@humanizer 400 installs
        └ https://skills.sh/writer/skills/humanizer

        eyh0602/skillshub@paper-polish 120 installs
        └ https://skills.sh/eyh0602/skillshub/paper-polish
      `,
    })

    const app = Server.Default()
    const search = await app.request("/skill/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        query: "找一下自动更新的skill",
        semantic: true,
      }),
    })

    expect(search.status).toBe(200)
    const body = await search.json()
    expect(body.main).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skills.volces.com@auto-updater", tier: "main" }),
        expect.objectContaining({ id: "yizhiyanhua-ai/skills-updater@skills-updater", tier: "main" }),
      ]),
    )
    expect(body.main).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "writer/skills@humanizer" }),
        expect.objectContaining({ id: "eyh0602/skillshub@paper-polish" }),
      ]),
    )
  })

  test("semantic exact updater search keeps canonical exact result in main", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "https://skills.sh/skills.volces.com/auto-updater") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Auto updater</h1>
            <p>Automatically update installed skills and keep local skill sets in sync.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/yizhiyanhua-ai/skills-updater/skills-updater") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Skills updater</h1>
            <p>Check installed skills, detect available updates, and refresh them with the Skills CLI.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      if (url === "https://skills.sh/custom/auto-updater-skill") {
        return new Response(
          `
          <span>SKILL.md</span>
          <div class="prose prose-invert max-w-none">
            <h1>Auto updater skill</h1>
            <p>Wrapper around updater routines for plugin packs.</p>
          </div>
          `,
          { status: 200 },
        )
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch

    textSpy = spyOn(Process, "text").mockResolvedValue({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      text: `
        skills.volces.com@auto-updater 38 installs
        └ https://skills.sh/skills.volces.com/auto-updater

        yizhiyanhua-ai/skills-updater@skills-updater 285 installs
        └ https://skills.sh/yizhiyanhua-ai/skills-updater/skills-updater

        custom/auto-updater-skill@auto-updater-skill 19 installs
        └ https://skills.sh/custom/auto-updater-skill
      `,
    })

    const app = Server.Default()
    const search = await app.request("/skill/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        query: "auto-updater",
        semantic: true,
      }),
    })

    expect(search.status).toBe(200)
    const body = await search.json()
    expect(body.main).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "skills.volces.com@auto-updater", tier: "main" })]),
    )
    expect(body.main).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "custom/auto-updater-skill@auto-updater-skill" })]),
    )
  })

  test("semantic exact search collapses duplicate external names in main", async () => {
    await using tmp = await tmpdir({
      config: {
        search_model: "opencode/qwen3.6-plus-free",
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await addGlobal(
        tmp.path,
        "plotly",
        "Create scientific plotting, charting, and interactive data visualization outputs.",
      )

      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "https://skills.sh/research/plotly") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Plotly</h1>
              <p>Create scientific plotting, charting, and interactive data visualization outputs.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        if (url === "https://skills.sh/templates/plotly") {
          return new Response(
            `
            <span>SKILL.md</span>
            <div class="prose prose-invert max-w-none">
              <h1>Plotly</h1>
              <p>Plotly starter templates for dashboards and charts.</p>
            </div>
            `,
            { status: 200 },
          )
        }
        return new Response("Not Found", { status: 404 })
      }) as typeof fetch

      textSpy = spyOn(Process, "text").mockResolvedValue({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        text: `
          research/plotly@plotly 80 installs
          └ https://skills.sh/research/plotly

          templates/plotly@plotly 51 installs
          └ https://skills.sh/templates/plotly
        `,
      })

      const app = Server.Default()
      const search = await app.request("/skill/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          query: "plotly",
          semantic: true,
        }),
      })

      expect(search.status).toBe(200)
      const body = await search.json()
      expect(body.main.filter((item: { name: string }) => item.name === "plotly")).toHaveLength(1)
      expect(body.main[0]).toEqual(expect.objectContaining({ name: "plotly", tier: "main" }))
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("describe returns a zh summary for an external skill page", async () => {
    await using tmp = await tmpdir({
      config: {},
    })

    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "https://skills.sh/vercel-labs/skills/find-skills") {
        return new Response(
          `
          <div class="text-xs font-mono uppercase text-(--ds-gray-600) mb-3">Summary</div>
          <div><div class="prose">
            <p><strong>Discover and install specialized agent skills from the open ecosystem when users need extended capabilities.</strong></p>
            <ul><li>Integrates with the Skills CLI.</li></ul>
          </div></div>
          `,
          { status: 200 },
        )
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch

    const app = Server.Default()
    const res = await app.request("/skill/describe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        id: "vercel-labs/skills@find-skills",
        name: "find-skills",
        provider: "external",
        source: "vercel-labs/skills",
        url: "https://skills.sh/vercel-labs/skills/find-skills",
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      summary_zh: expect.any(String),
      summary_source: "skills_summary",
    })
  })

  test("install queues background jobs with max two running", async () => {
    await using tmp = await tmpdir({
      config: {},
    })

    disposeSpy = spyOn(Instance, "dispose").mockResolvedValue(undefined)
    const a = wait()
    const b = wait()
    const c = wait()
    const run = Process.run
    runSpy = spyOn(Process, "run").mockImplementation(async (cmd, opts) => {
      if (cmd.includes("one/repo") && cmd.includes("first")) {
        return a.promise.then(() => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
      }
      if (cmd.includes("two/repo") && cmd.includes("second")) {
        return b.promise.then(() => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
      }
      if (cmd.includes("three/repo") && cmd.includes("third")) {
        return c.promise.then(() => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
      }
      return run(cmd, opts)
    })

    const app = Server.Default()
    const one = await (await app.request("/skill/install", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        kind: "external",
        package: "one/repo@first",
        scope: "project",
      }),
    })).json()
    const two = await (await app.request("/skill/install", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        kind: "external",
        package: "two/repo@second",
        scope: "project",
      }),
    })).json()
    const three = await (await app.request("/skill/install", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({
        kind: "external",
        package: "three/repo@third",
        scope: "project",
      }),
    })).json()

    expect(one.status).toBe("running")
    expect(two.status).toBe("running")
    expect(three.status).toBe("queued")

    const first = await (await app.request("/skill/jobs", {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })).json()
    expect(first).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "one/repo@first", status: "running" }),
        expect.objectContaining({ id: "two/repo@second", status: "running" }),
        expect.objectContaining({ id: "three/repo@third", status: "queued" }),
      ]),
    )

    a.resolve()
    const next = await jobs(app, tmp.path)
    expect(next).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "one/repo@first", status: "success" }),
        expect.objectContaining({ id: "three/repo@third", status: "running" }),
      ]),
    )

    b.resolve()
    c.resolve()
  })
})
