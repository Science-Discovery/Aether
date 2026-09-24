import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir as osTmpdir } from "os"
import { existsSync } from "fs"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

const get = (url: string, directory?: string) => {
  const app = Server.Default()
  return app.request(url, { headers: directory ? { "x-opencode-directory": directory } : {} })
}

const post = (url: string, body: unknown, directory?: string) => {
  const app = Server.Default()
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(directory ? { "x-opencode-directory": directory } : {}) },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("directory isolation", () => {
  test("unknown directory cannot anchor raw file reads", async () => {
    await using victim = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.txt"), "victim-secret")
      },
    })
    const app = Server.Default()

    // The temp root contains the victim directory, so a requester-chosen
    // containment root would pass every path check and leak the file.
    const res = await get(`/file/raw?path=${encodeURIComponent(path.join(victim.path, "secret.txt"))}`, osTmpdir())

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Access denied: path escapes project directory" })
    expect(Instance.has(victim.path)).toBe(false)
  })

  test("non-browse routes do not lazily boot instances for unknown directories", async () => {
    await using dir = await tmpdir()

    const res = await get("/path", dir.path)

    expect(res.status).toBe(200)
    expect(Instance.has(dir.path)).toBe(false)
    expect(Instance.dirs()).not.toContain(dir.path)
  })

  test("no-directory requests keep working against the server working directory", async () => {
    const res = await get("/file/raw?path=package.json")

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"name"')
  })

  test("project.open registers and boots a directory with contained file access", async () => {
    await using dir = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "doc.txt"), "project-file")
      },
    })
    await using outside = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "sneaky.txt"), "outside-secret")
      },
    })

    const opened = await post("/project/open", { directory: dir.path })
    expect(opened.status).toBe(200)
    const project = await opened.json()
    expect(project.worktree.replace(/\\/g, "/")).toBe(dir.path.replace(/\\/g, "/"))
    expect(Instance.has(dir.path)).toBe(true)

    const raw = await get(`/file/raw?path=${encodeURIComponent("doc.txt")}`, dir.path)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toBe("project-file")

    const escape = await get(`/file/raw?path=${encodeURIComponent(path.join(outside.path, "sneaky.txt"))}`, dir.path)
    expect(escape.status).toBe(400)
    expect(await escape.json()).toEqual({ error: "Access denied: path escapes project directory" })

    const missing = await post("/project/open", { directory: path.join(dir.path, "does-not-exist") })
    expect(missing.status).toBe(400)
  })

  test("registered project directories boot instances on demand", async () => {
    await using dir = await tmpdir()
    await Project.fromDirectory(dir.path)

    const res = await get("/path", dir.path)

    expect(res.status).toBe(200)
    expect(Instance.has(dir.path)).toBe(true)
  })

  test("registered directory content stays readable before an instance boots", async () => {
    await using dir = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "note.txt"), "recent-project")
      },
    })
    await Project.fromDirectory(dir.path)
    await Instance.disposeAll()

    const res = await get(`/file/raw?path=${encodeURIComponent("note.txt")}`, dir.path)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("recent-project")
  })

  test("ensure-directory can create its own browse root but nothing else", async () => {
    await using parent = await tmpdir()
    const fresh = path.join(parent.path, "brand-new-project")
    const nested = path.join(fresh, "nested")

    const root = await post("/file/ensure-directory", { path: fresh }, fresh)
    expect(root.status).toBe(200)
    expect(await root.json()).toEqual({ ok: true, path: fresh })
    expect(existsSync(fresh)).toBe(true)

    const nestedRes = await post("/file/ensure-directory", { path: nested }, fresh)
    expect(nestedRes.status).toBe(400)
    expect(await nestedRes.json()).toEqual({ error: "Access denied: path escapes project directory" })
    expect(existsSync(nested)).toBe(false)
  })

  test("find denies content search anchored at unknown directories", async () => {
    await using dir = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "note.txt"), "needle-SECRET-here")
      },
    })

    const denied = await get("/find?pattern=SECRET", dir.path)
    expect(denied.status).toBe(400)

    await Project.fromDirectory(dir.path)
    const allowed = await get("/find?pattern=SECRET", dir.path)
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).not.toHaveLength(0)
  }, 30000)

  test("browse contexts for unknown directories fail containment closed", async () => {
    await using dir = await tmpdir()

    const untrusted = await Instance.provide({
      directory: dir.path,
      create: false,
      fn: () => Instance.containsPath(path.join(dir.path, "any-file")),
    })
    expect(untrusted).toBe(false)

    await Instance.provide({ directory: dir.path, fn: () => {} })
    const booted = await Instance.provide({
      directory: dir.path,
      fn: () => Instance.containsPath(path.join(dir.path, "any-file")),
    })
    expect(booted).toBe(true)
  })
})
