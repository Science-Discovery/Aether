import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { existsSync } from "fs"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { Persist, filesDir } from "../../src/persist/naming"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

const post = (app: ReturnType<typeof Server.Default>, body: unknown, directory: string) =>
  app.request("/voice/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": directory },
    body: JSON.stringify(body),
  })

const payload = (projectID: string | undefined) => ({
  providerID: "test",
  modelID: "test",
  audioBase64: "QUJD",
  audioFormat: "webm",
  projectID,
  saveAudio: true,
})

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("voice projectID confinement", () => {
  test("rejects traversal projectID from the issue without writing outside files root", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const evil = ["..", "..", "Users", "evil", "Startup"].join(path.sep)
    const res = await post(app, payload(evil), tmp.path)

    expect(res.status).toBe(400)
    const escapeTarget = path.join(Persist.current.data, "Users", "evil", "Startup")
    expect(existsSync(escapeTarget)).toBe(false)
    expect(existsSync(path.join(Persist.current.data, "files"))).toBe(false)
  })

  test("rejects empty, dotted, and absolute-path projectIDs", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    for (const projectID of ["", "a.b", "../escape", "..\\escape", path.resolve(tmp.path, "elsewhere"), "C:\\evil"]) {
      const res = await post(app, payload(projectID), tmp.path)
      expect(res.status).toBe(400)
    }
  })

  test("valid projectID stops at provider lookup and never creates the files dir", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()

    const res = await post(app, payload("0123456789abcdef0123456789abcdef01234567"), tmp.path)
    expect(res.status).toBe(500)
    expect(existsSync(path.join(Persist.current.data, "files"))).toBe(false)
  })

  test("filesDir keeps legit project ids inside the files root", () => {
    const root = path.join(Persist.current.data, "files")
    for (const id of ["global", "0123456789abcdef0123456789abcdef01234567", "abc_DEF-123"]) {
      const dir = filesDir(id)
      expect(dir.startsWith(root + path.sep)).toBe(true)
    }
  })

  test("filesDir throws on traversal, absolute, and empty ids", () => {
    expect(() => filesDir(["..", "..", "evil"].join(path.sep))).toThrow()
    expect(() => filesDir("/../evil")).toThrow()
    expect(() => filesDir(".")).toThrow()
    expect(() => filesDir("")).toThrow()
  })
})
