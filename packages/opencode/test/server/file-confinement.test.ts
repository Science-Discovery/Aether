import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { existsSync } from "fs"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

const openerName = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open"

const post = (app: ReturnType<typeof Server.Default>, url: string, body: unknown, directory: string) =>
  app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": directory },
    body: JSON.stringify(body),
  })

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("file route confinement", () => {
  test("ensure-directory rejects paths outside the project", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const target = path.join(outside.path, "pwned")
    const res = await post(app, "/file/ensure-directory", { path: target }, tmp.path)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Access denied: path escapes project directory" })
    expect(existsSync(target)).toBe(false)
  })

  test("ensure-directory creates directories inside the project", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const target = path.join(tmp.path, "a", "b")
    const res = await post(app, "/file/ensure-directory", { path: target }, tmp.path)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, path: target })
    expect(existsSync(target)).toBe(true)
  })

  test("ensure-directory keeps the create-new-project flow via its own browse context", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const target = path.join(outside.path, "brand-new-project")
    const res = await post(app, "/file/ensure-directory", { path: target }, target)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, path: target })
    expect(existsSync(target)).toBe(true)
  })

  test("ensure-directory still requires absolute paths", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const res = await post(app, "/file/ensure-directory", { path: "relative/dir" }, tmp.path)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "path must be absolute" })
  })

  test("open rejects paths outside the project", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const res = await post(app, "/file/open", { path: path.join(outside.path, "tool") }, tmp.path)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Access denied: path escapes project directory" })
  })

  test("open rejects apps other than the system file opener", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const res = await post(app, "/file/open", { path: path.join(tmp.path, "doc.txt"), app: "notepad.exe" }, tmp.path)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "app must resolve to the system file opener" })
  })

  test("open accepts the resolved system opener and skips spawn for missing files", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const openerPath = Bun.which(openerName)
    if (!openerPath) return

    const res = await post(app, "/file/open", { path: path.join(tmp.path, "missing.txt"), app: openerPath }, tmp.path)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to access path" })
  })

  test("open-in-explorer rejects paths outside the project", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const res = await post(app, "/file/open-in-explorer", { path: path.join(outside.path, "tool") }, tmp.path)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Access denied: path escapes project directory" })
  })

  test("open-in-explorer still reports missing in-project paths", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const res = await post(app, "/file/open-in-explorer", { path: path.join(tmp.path, "missing") }, tmp.path)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to access path" })
  })

  test("pdf-page-count rejects paths and output dirs outside the project", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()
    const directory = tmp.path

    const escape = await app.request(
      `/file/pdf-page-count?path=${encodeURIComponent(path.join(outside.path, "doc.pdf"))}`,
      { headers: { "x-opencode-directory": directory } },
    )
    expect(escape.status).toBe(400)
    expect(await escape.json()).toEqual({ error: "Access denied: path escapes project directory" })

    const badDir = await app.request(
      `/file/pdf-page-count?path=${encodeURIComponent(path.join(tmp.path, "doc.pdf"))}&outputDir=${encodeURIComponent(outside.path)}`,
      { headers: { "x-opencode-directory": directory } },
    )
    expect(badDir.status).toBe(400)
    expect(await badDir.json()).toEqual({ error: "Access denied: path escapes project directory" })
  })

  test("pdf-to-markdown rejects paths and output dirs outside the project without starting a task", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()
    const directory = tmp.path
    const body = {
      providerID: "test",
      modelID: "test",
      startPage: 1,
      endPage: 1,
      outputMode: "merged",
      conflictAction: "cancel",
    }

    const escape = await post(
      app,
      "/file/pdf-to-markdown",
      { ...body, path: path.join(outside.path, "doc.pdf") },
      directory,
    )
    expect(escape.status).toBe(400)
    expect(await escape.json()).toEqual({ error: "Access denied: path escapes project directory" })

    const badDir = await post(
      app,
      "/file/pdf-to-markdown",
      { ...body, path: path.join(tmp.path, "doc.pdf"), outputDir: outside.path },
      directory,
    )
    expect(badDir.status).toBe(400)
    expect(await badDir.json()).toEqual({ error: "Access denied: path escapes project directory" })

    const missingDir = await post(
      app,
      "/file/pdf-to-markdown",
      { ...body, path: path.join(tmp.path, "doc.pdf"), outputDir: path.join(tmp.path, "nope") },
      directory,
    )
    expect(missingDir.status).toBe(400)
    expect(await missingDir.json()).toEqual({ error: "路径必须指向一个文件夹" })

    const tasks = await app.request("/file/active-tasks", { headers: { "x-opencode-directory": directory } })
    expect(await tasks.json()).toEqual([])
  })

  test("translate-markdown rejects paths and output dirs outside the project", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()
    const directory = tmp.path
    const body = { providerID: "test", modelID: "test", conflictAction: "cancel" }

    const escape = await post(
      app,
      "/file/translate-markdown",
      { ...body, path: path.join(outside.path, "notes.md") },
      directory,
    )
    expect(escape.status).toBe(400)
    expect(await escape.json()).toEqual({ error: "Access denied: path escapes project directory" })

    const badDir = await post(
      app,
      "/file/translate-markdown",
      { ...body, path: path.join(tmp.path, "notes.md"), outputDir: outside.path },
      directory,
    )
    expect(badDir.status).toBe(400)
    expect(await badDir.json()).toEqual({ error: "Access denied: path escapes project directory" })
  })

  test("translate-markdown check rejects outside paths and works inside the project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "note.md"), "# hello\nworld")
      },
    })
    await using outside = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()
    const directory = tmp.path

    const escape = await app.request(
      `/file/translate-markdown/check?path=${encodeURIComponent(path.join(outside.path, "secret.md"))}`,
      { headers: { "x-opencode-directory": directory } },
    )
    expect(escape.status).toBe(400)
    expect(await escape.json()).toEqual({ error: "Access denied: path escapes project directory" })

    const ok = await app.request(`/file/translate-markdown/check?path=${encodeURIComponent("note.md")}`, {
      headers: { "x-opencode-directory": directory },
    })
    expect(ok.status).toBe(200)
    const data = await ok.json()
    expect(data.hasDataJson).toBe(false)
    expect(data.chunkCount).toBeGreaterThan(0)
    expect(data.outputPath.replace(/\\/g, "/")).toBe(`${tmp.path.replace(/\\/g, "/")}/note_zh.md`)
  })
})
