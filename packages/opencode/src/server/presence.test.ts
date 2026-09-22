import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@/global"
import { Presence, marker, parse, type Info } from "./presence"

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presence-test-"))
  return {
    path: dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

const SIBLING: Info = {
  pid: process.pid + 1,
  channel: "local",
  clients: { desktop: 1, web: 0 },
}

function infoByPid(infos: Info[], pid: number) {
  return infos.find((info) => info.pid === pid)
}

describe("presence parse", () => {
  test("accepts a valid payload", () => {
    const info = parse({ pid: 1, channel: "prod", clients: { desktop: 2, web: 0 } })
    expect(info).toEqual({ pid: 1, channel: "prod", clients: { desktop: 2, web: 0 } })
  })

  test("rejects malformed payloads", () => {
    expect(parse(null)).toBeNull()
    expect(parse(undefined)).toBeNull()
    expect(parse({})).toBeNull()
    expect(parse({ pid: "x", channel: "prod", clients: { desktop: 0, web: 1 } })).toBeNull()
    expect(parse({ pid: 1, channel: 2, clients: { desktop: 0, web: 1 } })).toBeNull()
    expect(parse({ pid: 1, channel: "prod" })).toBeNull()
    expect(parse({ pid: 1, channel: "prod", clients: { desktop: "0", web: 1 } })).toBeNull()
  })
})

describe("marker", () => {
  test("maps the client header, defaulting to web", () => {
    expect(marker("desktop")).toBe("desktop")
    expect(marker("web")).toBe("web")
    expect(marker(undefined)).toBe("web")
    expect(marker("bogus")).toBe("web")
  })
})

describe("presence roster", () => {
  test("joins and leaves connections, counting by type", () => {
    const a = Presence.join("desktop")
    const b = Presence.join("web")
    const c = Presence.join("web")
    expect(Presence.clients()).toEqual({ desktop: 1, web: 2 })
    Presence.leave(b)
    expect(Presence.clients()).toEqual({ desktop: 1, web: 1 })
    Presence.leave(a)
    Presence.leave(c)
    expect(Presence.clients()).toEqual({ desktop: 0, web: 0 })
  })

  test("info carries the channel slug", () => {
    const before = Presence.clients()
    const info = Presence.info()
    expect(info.pid).toBe(process.pid)
    expect(typeof info.channel).toBe("string")
    expect(info.clients).toEqual(before)
  })
})

describe("presence others scan", () => {
  let tmp: Awaited<ReturnType<typeof makeTmp>>
  let origData: string

  beforeEach(async () => {
    tmp = await makeTmp()
    origData = Global.Path.data
    ;(Global.Path as { data: string }).data = tmp.path
  })

  afterEach(async () => {
    ;(Global.Path as { data: string }).data = origData
    await tmp.cleanup()
  })

  test("respects AETHER_PRESENCE_SCAN=0", async () => {
    process.env.AETHER_PRESENCE_SCAN = "0"
    try {
      const others = await Presence.others(() => Promise.reject(new Error("should not fetch")))
      expect(others).toEqual([])
    } finally {
      delete process.env.AETHER_PRESENCE_SCAN
    }
  })

  test("discovers same-channel siblings via serve-port files over real HTTP", async () => {
    const siblingPort = 20901
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
    try {
      const others = await Presence.others()
      expect(infoByPid(others, SIBLING.pid)).toEqual(SIBLING)
    } finally {
      server.stop(true)
    }
  })

  test("drops siblings on other channels", async () => {
    const siblingPort = 20902
    await fs.mkdir(path.join(tmp.path, "prod"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "prod", "serve-port"), String(siblingPort))
    const foreign: Info = { pid: process.pid + 2, channel: "prod", clients: { desktop: 0, web: 1 } }
    const seen: string[] = []
    const server = Bun.serve({
      port: siblingPort,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: (req) => {
        seen.push(new URL(req.url).pathname)
        return Response.json(foreign)
      },
    })
    try {
      const others = await Presence.others()
      expect(infoByPid(others, foreign.pid)).toBeUndefined()
      expect(seen).toEqual(["/global/presence"])
    } finally {
      server.stop(true)
    }
  })

  test("excludes the server itself by pid and sends the suppression header", async () => {
    const selfPort = 19527
    const self: Info = { pid: process.pid, channel: "local", clients: { desktop: 0, web: 5 } }
    let suppress: string | undefined
    const impl = (url: string, init?: RequestInit) => {
      suppress = new Headers(init?.headers).get("x-aether-presence-scan") ?? undefined
      const port = new URL(url).port
      if (Number(port) === selfPort) return Promise.resolve(Response.json(self))
      return Promise.reject(new Error("dead"))
    }
    const others = await Presence.others(impl)
    expect(infoByPid(others, process.pid)).toBeUndefined()
    expect(suppress).toBe("0")
  })

  test("skips servers that answer with garbage or fail", async () => {
    const garbagePort = 20911
    const impl = (url: string) => {
      const port = new URL(url).port
      if (Number(port) === garbagePort) return Promise.resolve(Response.json({ hello: "world" }))
      return Promise.resolve(new Response("nope", { status: 404 }))
    }
    const others = await Presence.others(impl)
    expect(others).toEqual([])
  })
})
