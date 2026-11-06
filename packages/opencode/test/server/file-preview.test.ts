import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

function resource(dir: string, file: string, method = "GET") {
  return Server.Default().request(`/file/preview/resource?path=${encodeURIComponent(file)}`, {
    method,
    headers: { "x-opencode-directory": dir },
  })
}

describe("local preview resources", () => {
  test("serves CSS, image, and font bytes with download isolation", async () => {
    const entries = [
      ["style.CSS", "text/css"],
      ["photo.JPEG", "image/jpeg"],
      ["picture.png", "image/png"],
      ["graphic.svg", "image/svg+xml"],
      ["font.woff2", "font/woff2"],
      ["font.ttf", "font/ttf"],
    ]
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Promise.all(entries.map(([name]) => Bun.write(path.join(dir, name!), new Uint8Array([0, 1, 2, 255]))))
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    for (const [name, type] of entries) {
      const res = await resource(tmp.path, name!)
      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Type")).toBe(type!)
      expect(res.headers.get("Content-Length")).toBe("4")
      expect(res.headers.get("Content-Disposition")).toStartWith("attachment;")
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
      expect(res.headers.get("Cache-Control")).toBe("no-cache")
      expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox")
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]))
    }
  })

  test("preserves Chinese, literal percent escapes, and hashes without a second URL decode", async () => {
    const name = "%2e%2e/图%20片#1.svg"
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, name), '<svg xmlns="http://www.w3.org/2000/svg"><text>内容</text></svg>')
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const res = await resource(tmp.path, name)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("内容")
    expect(res.headers.get("Content-Disposition")).toContain("%2520")
    expect(res.headers.get("Content-Disposition")).toContain("%231.svg")
  })

  test("documents the actual query validation and resource error responses", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const doc = await Server.openapi()
    const responses = doc.paths?.["/file/preview/resource"]?.get?.responses
    const failure = { type: "object", properties: { error: { type: "string" } }, required: ["error"] }
    expect(responses?.["400"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            anyOf: [
              failure,
              {
                type: "object",
                properties: { data: { type: "object" }, error: { type: "array" }, success: { const: false } },
                required: ["data", "error", "success"],
              },
            ],
          },
        },
      },
    })
    for (const status of [403, 404, 415]) {
      expect(responses?.[String(status)]).toMatchObject({
        content: { "application/json": { schema: failure } },
      })
    }
    const invalid = await Server.Default().request("/file/preview/resource", {
      headers: { "x-opencode-directory": tmp.path },
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      data: {},
      error: [expect.objectContaining({ path: ["path"] })],
      success: false,
    })
    const cases = [
      ["", 400],
      ["../outside.css", 403],
      ["missing.css", 404],
      ["page.html", 415],
    ] as const
    await Promise.all(
      cases.map(async ([file, status]) => {
        const res = await resource(tmp.path, file)
        expect(res.status).toBe(status)
        const body = await res.json()
        expect(Object.keys(body)).toEqual(["error"])
        expect(body.error).toBeString()
      }),
    )
  })

  test("rejects HTML, script, data, and document resources", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    for (const name of ["page.html", "code.js", "data.json", "book.xlsx", "paper.pdf", "picture"])
      expect((await resource(tmp.path, name)).status).toBe(415)
  })

  test("rejects filesystem paths and URL schemes", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    for (const name of [
      path.join(tmp.path, "image.png"),
      "C:/image.png",
      "C:image.png",
      "\\\\server\\share\\image.png",
      "file:///image.png",
      "https://example.com/image.png",
      "data:image/png;base64,a",
      "image\0.png",
      "",
    ])
      expect((await resource(tmp.path, name)).status).toBe(400)
  })

  test("does not allow lexical traversal to a sibling workspace", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "workspace"))
        await Bun.write(path.join(dir, "secret.css"), "outside")
      },
    })
    const dir = path.join(tmp.path, "workspace")
    await Instance.provide({ directory: dir, fn: () => {} })
    const res = await resource(dir, "../secret.css")
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("outside")
  })

  test("rejects a directory junction escaping the workspace", async () => {
    await using outside = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "secret.css"), "outside"),
    })
    await using tmp = await tmpdir({
      init: (dir) =>
        fs.symlink(outside.path, path.join(dir, "linked"), process.platform === "win32" ? "junction" : "dir"),
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const res = await resource(tmp.path, "linked/secret.css")
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("outside")
  })

  test("allows an internal directory junction and rejects non-file targets", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "assets", "style.css"), "body{color:blue}")
        await fs.symlink(
          path.join(dir, "assets"),
          path.join(dir, "linked"),
          process.platform === "win32" ? "junction" : "dir",
        )
        await fs.mkdir(path.join(dir, "directory.css"))
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    expect(await (await resource(tmp.path, "linked/style.css")).text()).toBe("body{color:blue}")
    expect((await resource(tmp.path, "directory.css")).status).toBe(400)
    expect((await resource(tmp.path, "missing.css")).status).toBe(404)
    expect((await resource(tmp.path, "assets/style.css/child.css")).status).toBe(404)
  })

  test("unknown directories cannot anchor preview reads", async () => {
    await using tmp = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "style.css"), "secret") })
    const res = await resource(tmp.path, "style.css")
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("secret")
    expect(Instance.has(tmp.path)).toBe(false)
  })

  test("a worktree parent does not enlarge the active workspace boundary", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "workspace"))
        await Bun.write(path.join(dir, "style.css"), "outside")
      },
    })
    const dir = path.join(tmp.path, "workspace")
    await Instance.provide({ directory: dir, fn: () => {} })
    expect((await resource(dir, "../style.css")).status).toBe(403)
  })

  test("HEAD returns isolation headers without a body", async () => {
    await using tmp = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "style.css"), "body{}") })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const res = await resource(tmp.path, "style.css", "HEAD")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Length")).toBe("6")
    expect(res.headers.get("Content-Disposition")).toStartWith("attachment;")
    expect(await res.text()).toBe("")
  })

  test("requires server authentication before reading preview bytes", async () => {
    await using tmp = await tmpdir()
    const proc = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "file-preview.probe.ts"), tmp.path], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: "preview-test-password",
        OPENCODE_DISABLE_MOBILE: "1",
        OPENCODE_DB: ":memory:",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain("preview authentication passed")
  }, 30000)
})
