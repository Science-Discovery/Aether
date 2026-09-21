import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@/global"
import { parse, Presence, type Info } from "./presence"

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presence-test-"))
  return {
    path: dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

const SIBLING: Info = {
  pid: process.pid + 1,
  channel: "prod",
  kind: "desktop",
  clients: { desktop: 1, web: 0 },
}

function infoByPid(infos: Info[], pid: number) {
  return infos.find((info) => info.pid === pid)
}

describe("presence parse", () => {
  test("accepts a valid payload", () => {
    const info = parse({ pid: 1, channel: "prod", kind: "desktop", clients: { desktop: 2, web: 0 } })
    expect(info).toEqual({ pid: 1, channel: "prod", kind: "desktop", clients: { desktop: 2, web: 0 } })
  })

  test("rejects malformed payloads", () => {
    expect(parse(null)).toBeNull()
    expect(parse(undefined)).toBeNull()
    expect(parse({})).toBeNull()
    expect(parse({ pid: "x", channel: "prod", kind: "web", clients: { desktop: 0, web: 1 } })).toBeNull()
    expect(parse({ pid: 1, channel: "prod", kind: "other", clients: { desktop: 0, web: 1 } })).toBeNull()
    expect(parse({ pid: 1, channel: "prod", kind: "web", clients: { desktop: "0", web: 1 } })).toBeNull()
  })
})

describe("presence others scan", () => {
  let tmp: Awaited<ReturnType<typeof makeTmp>>
  let origData: string

  beforeEach(async () => {
    tmp = await makeTmp()
    origData = Global.Path.data
    ;(Global.Path as { data: string }).data = tmp.path
    Presence.attach(undefined)
  })

  afterEach(async () => {
    Presence.attach(undefined)
    ;(Global.Path as { data: string }).data = origData
    await tmp.cleanup()
  })

  test("returns empty when no server port is attached", async () => {
    await fs.mkdir(path.join(tmp.path, "prod"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "prod", "serve-port"), "20901")
    const fetched: string[] = []
    const others = await Presence.others((url) => {
      fetched.push(url)
      throw new Error("should not fetch")
    })
    expect(others).toEqual([])
    expect(fetched).toEqual([])
  })

  test("respects AETHER_PRESENCE_SCAN=0", async () => {
    Presence.attach(20903)
    process.env.AETHER_PRESENCE_SCAN = "0"
    try {
      const others = await Presence.others(() => Promise.reject(new Error("should not fetch")))
      expect(others).toEqual([])
    } finally {
      delete process.env.AETHER_PRESENCE_SCAN
    }
  })

  test("discovers siblings via serve-port files over real HTTP", async () => {
    const siblingPort = 20901
    const selfPort = 20903
    await fs.mkdir(path.join(tmp.path, "prod"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "prod", "serve-port"), String(siblingPort))
    await fs.mkdir(path.join(tmp.path, "local"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "local", "serve-port"), "9") // unreachable

    const server = Bun.serve({
      port: siblingPort,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: () => Response.json(SIBLING),
    })
    Presence.attach(selfPort)
    try {
      const others = await Presence.others()
      expect(infoByPid(others, SIBLING.pid)).toEqual(SIBLING)
    } finally {
      server.stop(true)
    }
  })

  test("excludes the server itself by port and by pid", async () => {
    const selfPort = 20913
    const self: Info = { pid: process.pid, channel: "local", kind: "web", clients: { desktop: 0, web: 5 } }
    const impl = (url: string) => {
      const port = new URL(url).port
      if (Number(port) === selfPort) return Promise.resolve(Response.json(self))
      return Promise.reject(new Error("dead"))
    }
    Presence.attach(selfPort)
    const others = await Presence.others(impl)
    expect(infoByPid(others, process.pid)).toBeUndefined()
  })

  test("skips servers that answer with garbage or fail", async () => {
    const garbagePort = 20911
    const impl = (url: string) => {
      const port = new URL(url).port
      if (Number(port) === garbagePort) return Promise.resolve(Response.json({ hello: "world" }))
      return Promise.resolve(new Response("nope", { status: 404 }))
    }
    Presence.attach(20913)
    const others = await Presence.others(impl)
    expect(others).toEqual([])
  })
})

describe("presence stream counting", () => {
  test("counts open streams by kind and floors at zero", () => {
    const orig = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "web"
    try {
      const before = Presence.clients()
      Presence.open()
      Presence.open()
      const mid = Presence.clients()
      Presence.close()
      Presence.close()
      Presence.close()
      const after = Presence.clients()
      expect(mid).toEqual({ desktop: 0, web: before.web + 2 })
      expect(after).toEqual(before)
    } finally {
      if (orig === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = orig
    }
  })

  test("attributes streams to desktop when spawned by the desktop app", () => {
    const orig = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "desktop"
    try {
      const before = Presence.clients()
      Presence.open()
      expect(Presence.clients()).toEqual({ desktop: before.desktop + 1, web: 0 })
      Presence.close()
      expect(Presence.clients()).toEqual(before)
    } finally {
      if (orig === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = orig
    }
  })
})
