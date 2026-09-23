import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const originalHome = process.env.OPENCODE_TEST_HOME
const originalLocalAppData = process.env.LOCALAPPDATA

afterEach(() => {
  if (originalHome === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = originalHome
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
})

function aetherDir(root: string) {
  if (process.platform === "win32") return path.join(root, "aether")
  return path.join(root, ".local", "share", "aether")
}

async function redirectDataHome(root: string) {
  process.env.OPENCODE_TEST_HOME = root
  process.env.LOCALAPPDATA = root
  const dir = aetherDir(root)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function getState(app: ReturnType<typeof Server.Default>) {
  const res = await app.request("/knowledge/state")
  expect(res.status).toBe(200)
  return res.json()
}

async function putState(app: ReturnType<typeof Server.Default>, data: unknown) {
  const res = await app.request("/knowledge/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { ok: boolean }
}

describe("knowledge state persistence", () => {
  test("roundtrips state through a dedicated file and never touches the desktop store", async () => {
    await using home = await tmpdir()
    const dir = await redirectDataHome(home.path)
    const globalFile = path.join(dir, "aether.global.dat")
    const desktop = { notification: { list: [{ id: "n1" }] }, layout: { sidebar: true } }
    await Bun.write(globalFile, JSON.stringify(desktop))
    const app = Server.Default()

    const state = { knowledgeBases: [{ id: "kb1" }], activeIds: ["kb1"], lastConfig: { chunkSize: 512 } }
    expect(await putState(app, state)).toEqual({ ok: true })

    const stored = JSON.parse(await fs.readFile(path.join(dir, "aether.knowledge.dat"), "utf-8"))
    expect(stored["knowledge-state"]).toEqual(state)
    expect(JSON.parse(await fs.readFile(globalFile, "utf-8"))).toEqual(desktop)
    expect(await getState(app)).toEqual(state)
  })

  test("migrates knowledge-state from the legacy global file once", async () => {
    await using home = await tmpdir()
    const dir = await redirectDataHome(home.path)
    const globalFile = path.join(dir, "aether.global.dat")
    const state = { knowledgeBases: [{ id: "kb-legacy" }], activeIds: ["kb-legacy"] }
    await Bun.write(
      globalFile,
      JSON.stringify({ notification: { list: [] }, "knowledge-state": state, layout: { page: "home" } }),
    )
    const app = Server.Default()

    expect(await getState(app)).toEqual(state)

    const stored = JSON.parse(await fs.readFile(path.join(dir, "aether.knowledge.dat"), "utf-8"))
    expect(stored["knowledge-state"]).toEqual(state)

    await fs.rm(globalFile)
    expect(await getState(app)).toEqual(state)

    const desktop = { notification: { list: [{ id: "n1" }] } }
    await Bun.write(globalFile, JSON.stringify(desktop))
    await putState(app, { knowledgeBases: [{ id: "kb2" }], activeIds: ["kb2"] })
    expect(JSON.parse(await fs.readFile(globalFile, "utf-8"))).toEqual(desktop)
  })

  test("knowledge writes and desktop store rewrites no longer clobber each other", async () => {
    await using home = await tmpdir()
    const dir = await redirectDataHome(home.path)
    const globalFile = path.join(dir, "aether.global.dat")
    const knowledgeFile = path.join(dir, "aether.knowledge.dat")
    await Bun.write(globalFile, JSON.stringify({ notification: { list: ["seed"] }, layout: { sidebar: true } }))
    const app = Server.Default()

    const desktopRewrite = async (i: number) => {
      const store = JSON.parse(await fs.readFile(globalFile, "utf-8"))
      store.notification = { list: [`ping-${i}`] }
      await Bun.write(globalFile, JSON.stringify(store))
    }
    const knowledgeWrite = async (i: number) => {
      await putState(app, { knowledgeBases: [{ id: `kb-${i}` }], activeIds: [`kb-${i}`] })
    }

    const steps: Promise<void>[] = []
    for (let i = 0; i < 10; i++) {
      steps.push(desktopRewrite(i), knowledgeWrite(i))
    }
    await Promise.all(steps)

    const desktop = JSON.parse(await fs.readFile(globalFile, "utf-8"))
    expect(desktop.notification.list).toHaveLength(1)
    expect(desktop.notification.list[0]).toMatch(/^ping-\d$/)
    expect(desktop.layout).toEqual({ sidebar: true })
    expect(desktop["knowledge-state"]).toBeUndefined()

    const stored = JSON.parse(await fs.readFile(knowledgeFile, "utf-8"))
    expect(stored["knowledge-state"]).toEqual({ knowledgeBases: [{ id: "kb-9" }], activeIds: ["kb-9"] })
  })

  test("falls back to the legacy file when the dedicated file is missing, then heals a corrupt one", async () => {
    await using home = await tmpdir()
    const dir = await redirectDataHome(home.path)
    const knowledgeFile = path.join(dir, "aether.knowledge.dat")
    const state = { knowledgeBases: [{ id: "kb-old" }], activeIds: ["kb-old"] }
    await Bun.write(path.join(dir, "aether.global.dat"), JSON.stringify({ "knowledge-state": state }))
    await Bun.write(knowledgeFile, "{corrupt")
    const app = Server.Default()

    expect(await getState(app)).toEqual(state)
    const healed = JSON.parse(await fs.readFile(knowledgeFile, "utf-8"))
    expect(healed["knowledge-state"]).toEqual(state)
  })

  test("returns the default state for a fresh install without creating files", async () => {
    await using home = await tmpdir()
    const dir = await redirectDataHome(home.path)
    const app = Server.Default()

    expect(await getState(app)).toEqual({ knowledgeBases: [], activeIds: [] })
    expect(
      await fs.stat(path.join(dir, "aether.knowledge.dat")).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
  })

  test("serializes concurrent knowledge writes without data loss", async () => {
    await using home = await tmpdir()
    const dir = await redirectDataHome(home.path)
    const app = Server.Default()

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        app.request("/knowledge/state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: { knowledgeBases: [{ id: `kb-${i}` }], activeIds: [`kb-${i}`] } }),
        }),
      ),
    )
    for (const res of results) expect(res.status).toBe(200)

    const stored = JSON.parse(await fs.readFile(path.join(dir, "aether.knowledge.dat"), "utf-8"))
    expect(stored["knowledge-state"]).toEqual({
      knowledgeBases: [{ id: "kb-9" }],
      activeIds: ["kb-9"],
    })
    expect(await getState(app)).toEqual(stored["knowledge-state"])
  })
})
