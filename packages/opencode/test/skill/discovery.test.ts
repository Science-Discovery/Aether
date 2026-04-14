import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { NodePath } from "@effect/platform-node"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Discovery } from "../../src/skill/discovery"
import { Global } from "../../src/global"
import { Filesystem } from "../../src/util/filesystem"
import { AppFileSystem } from "../../src/filesystem"
import { rm } from "fs/promises"
import path from "path"
import { serve } from "../lib/server"

let CLOUDFLARE_SKILLS_URL: string
let server: ReturnType<typeof Bun.serve>
let downloadCount = 0
const nativeFetch = globalThis.fetch

const fixturePath = path.join(import.meta.dir, "../fixture/skills")
const cacheDir = path.join(Global.Path.cache, "skills")

beforeAll(async () => {
  server = await serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url)

      // route /.well-known/skills/* to the fixture directory
      if (url.pathname.startsWith("/.well-known/skills/")) {
        const filePath = url.pathname.replace("/.well-known/skills/", "")
        const fullPath = path.join(fixturePath, filePath)

        if (await Filesystem.exists(fullPath)) {
          if (!fullPath.endsWith("index.json")) {
            downloadCount++
          }
          return new Response(Bun.file(fullPath))
        }
      }

      return new Response("Not Found", { status: 404 })
    },
  })

  CLOUDFLARE_SKILLS_URL = `http://localhost:${server.port}/.well-known/skills/`
})

beforeEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
  downloadCount = 0
})

afterAll(async () => {
  server?.stop()
  await rm(cacheDir, { recursive: true, force: true })
})

describe("Discovery.pull", () => {
  const layer = Discovery.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((req) =>
          Effect.promise(async () => {
            const res = await nativeFetch(req.url, { method: req.method })
            return HttpClientResponse.fromWeb(req, res)
          }),
        ),
      ),
    ),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(NodePath.layer),
  )
  const pull = (url: string) =>
    Effect.runPromise(Discovery.Service.use((s) => s.pull(url)).pipe(Effect.provide(layer)))

  test("downloads skills from cloudflare url", async () => {
    const dirs = await pull(CLOUDFLARE_SKILLS_URL)
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      expect(dir).toStartWith(cacheDir)
      const md = path.join(dir, "SKILL.md")
      expect(await Filesystem.exists(md)).toBe(true)
    }
  })

  test("url without trailing slash works", async () => {
    const dirs = await pull(CLOUDFLARE_SKILLS_URL.replace(/\/$/, ""))
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      const md = path.join(dir, "SKILL.md")
      expect(await Filesystem.exists(md)).toBe(true)
    }
  })

  test("returns empty array for invalid url", async () => {
    const dirs = await pull(`http://localhost:${server.port}/invalid-url/`)
    expect(dirs).toEqual([])
  })

  test("returns empty array for non-json response", async () => {
    // any url not explicitly handled in server returns 404 text "Not Found"
    const dirs = await pull(`http://localhost:${server.port}/some-other-path/`)
    expect(dirs).toEqual([])
  })

  test("downloads reference files alongside SKILL.md", async () => {
    const dirs = await pull(CLOUDFLARE_SKILLS_URL)
    const out = await Promise.all(
      dirs.map(async (dir) => {
        const refs = path.join(dir, "references")
        if (!(await Filesystem.exists(refs))) return
        const files = await Array.fromAsync(new Bun.Glob("**/*.md").scan({ cwd: refs, onlyFiles: true }))
        if (files.length === 0) return
        return { dir, files }
      }),
    )
    const hit = out.find(Boolean)
    expect(hit).toBeDefined()
    if (hit) expect(await Filesystem.exists(path.join(hit.dir, "SKILL.md"))).toBe(true)
  })

  test("caches downloaded files on second pull", async () => {
    // first pull to populate cache
    const first = await pull(CLOUDFLARE_SKILLS_URL)
    expect(first.length).toBeGreaterThan(0)
    const firstCount = downloadCount
    expect(firstCount).toBeGreaterThan(0)

    // second pull should return same results from cache
    const second = await pull(CLOUDFLARE_SKILLS_URL)
    expect(second.length).toBe(first.length)
    expect(second.sort()).toEqual(first.sort())

    // second pull should NOT increment download count
    expect(downloadCount).toBe(firstCount)
  })
})
