import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
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

function wait() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(async () => {
  await resetDatabase()
  textSpy?.mockRestore()
  runSpy?.mockRestore()
  disposeSpy?.mockRestore()
  textSpy = undefined
  runSpy = undefined
  disposeSpy = undefined
  globalThis.fetch = originalFetch
})

describe("skill routes", () => {
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

  test("search returns quickly when external cli stalls", async () => {
    await using tmp = await tmpdir({
      config: {},
    })

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
        query: "auto updater",
        semantic: false,
      }),
    })

    expect(search.status).toBe(200)
    expect(Date.now() - start).toBeLessThan(3_000)
    expect(await search.json()).toEqual({
      main: [],
      more: [],
      meta: expect.objectContaining({
        model: expect.any(String),
        latency_ms: expect.any(Number),
      }),
    })
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
      const query = cmd.at(-1) ?? ""
      if (!String(query).includes("论文")) {
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
    expect(body.more).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "paulrberg/agent-skills@code-polish",
          tier: "more",
        }),
      ]),
    )
  })

  test("semantic search keeps exact external hits without正文 out of main", async () => {
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
    expect(body.main).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "writer/skills@professional-proofreader",
        }),
      ]),
    )
    expect(body.more).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "writer/skills@professional-proofreader",
          tier: "more",
        }),
      ]),
    )
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
    let calls = 0
    runSpy = spyOn(Process, "run").mockImplementation(async () => {
      calls += 1
      if (calls === 1) return a.promise.then(() => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
      if (calls === 2) return b.promise.then(() => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
      return c.promise.then(() => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
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
    const next = await new Promise<any[]>(async (resolve, reject) => {
      const end = Date.now() + 500
      while (Date.now() < end) {
        const jobs = await (await app.request("/skill/jobs", {
          headers: {
            "x-opencode-directory": tmp.path,
          },
        })).json()
        if (jobs.some((item: { id: string; status: string }) => item.id === "one/repo@first" && item.status === "success")) {
          resolve(jobs)
          return
        }
        await new Promise((done) => setTimeout(done, 10))
      }
      reject(new Error("first install did not finish in time"))
    })
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
