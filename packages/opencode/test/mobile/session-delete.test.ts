import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { existsSync } from "fs"
import { mkdir, rm } from "fs/promises"
import { join } from "path"
import { createMobileRoutes } from "../../src/mobile/route"
import { FeishuManager } from "../../src/mobile/feishu"
import { QQManager } from "../../src/mobile/qq"
import { WeChatManager } from "../../src/mobile/wechat"
import * as ilink from "../../src/mobile/ilink"
import type { PollResult } from "../../src/mobile/ilink"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { platformDir } from "../../src/persist/naming"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const managers = { feishu: FeishuManager, qq: QQManager, wechat: WeChatManager }
const platforms = ["feishu", "qq", "wechat"] as const

let root = ""
const realAppData = process.env.APPDATA

beforeAll(async () => {
  const tmp = await tmpdir()
  root = tmp.path
  process.env.APPDATA = root
})

afterAll(async () => {
  mock.module("../../src/mobile/ilink", () => ({ ...ilink }))
  if (realAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = realAppData
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  for (const p of platforms) await rm(platformDir(p), { recursive: true, force: true })
})

afterEach(async () => {
  gate.release({ messages: [], cursor: "", expired: false })
  mock.restore()
  const m = WeChatManager as any
  m._pollRunning = false
  m._pollGen = 0
  m._ilinkToken = ""
  m._cursor = ""
  m._loginAbort = null
  m._tokenKnownExpired = false
  m._wcSession = null
  await Instance.disposeAll()
  await resetDatabase()
})

const gate = (() => {
  let release: (v: PollResult) => void = () => {}
  return {
    promise: new Promise<PollResult>((r) => (release = r)),
    release,
  }
})()

function freshGate() {
  let release: (v: PollResult) => void = () => {}
  gate.promise = new Promise<PollResult>((r) => (release = r))
  gate.release = release
}

async function deleteSession(p: (typeof platforms)[number], dir: string) {
  const app = Server.Default()
  return app.request(`/mobile/${p}/session`, {
    method: "DELETE",
    headers: { "x-opencode-directory": dir },
  })
}

describe("mobile delete session", () => {
  for (const p of platforms) {
    test(`${p}: delete stops the bridge before clearing state`, async () => {
      await using tmp = await tmpdir()
      const m = managers[p]
      const order: string[] = []
      const stop = spyOn(m, "stop").mockImplementation(async () => {
        order.push("stop")
      })
      const clear = spyOn(m, "clearSession").mockImplementation(async () => {
        order.push("clear")
      })
      const res = await deleteSession(p, tmp.path)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
      expect(stop).toHaveBeenCalledTimes(1)
      expect(clear).toHaveBeenCalledTimes(1)
      expect(order).toEqual(["stop", "clear"])
    })

    test(`${p}: delete removes credentials and closes supervisor restart gates`, async () => {
      await using tmp = await tmpdir()
      const m = managers[p]
      const dir = platformDir(p)
      await m.setDesired(true)
      await mkdir(dir, { recursive: true })
      if (p === "wechat") {
        await Bun.write(
          join(dir, "ilink_state.json"),
          JSON.stringify({ token: "t", cursor: "c", baseUrl: "https://ilink.example" }),
        )
        await Bun.write(
          join(dir, "session.json"),
          JSON.stringify({ connected: true, user: { id: "u", name: "n" }, createdAt: 1 }),
        )
      } else {
        await Bun.write(join(dir, "config.json"), JSON.stringify({ appId: "a", appSecret: "s" }))
      }

      const res = await deleteSession(p, tmp.path)
      expect(res.status).toBe(200)

      expect(await m.desired()).toBe(false)
      expect(await m.hasCredentials()).toBe(false)
      expect(m.status).toBe("idle")
      if (p === "wechat") {
        expect(existsSync(join(dir, "ilink_state.json"))).toBe(false)
        expect(existsSync(join(dir, "session.json"))).toBe(false)
        expect((m as any)._pollRunning).toBe(false)
      } else {
        expect(existsSync(join(dir, "config.json"))).toBe(false)
        expect((m as any)._manualStop).toBe(true)
      }
    })

    test(`${p}: delete is idempotent when the bridge never started`, async () => {
      await using tmp = await tmpdir()
      const res = await deleteSession(p, tmp.path)
      expect(res.status).toBe(200)
      const again = await deleteSession(p, tmp.path)
      expect(again.status).toBe(200)
    })
  }

  test("wechat: stop invalidates in-flight poll so deleted state stays deleted", async () => {
    await using tmp = await tmpdir()
    freshGate()
    const m = WeChatManager as any
    let calls = 0
    mock.module("../../src/mobile/ilink", () => ({
      ...ilink,
      getUpdates: () => {
        calls++
        return gate.promise
      },
    }))

    const dir = platformDir("wechat")
    await mkdir(dir, { recursive: true })
    m._initialized = true
    m._pollRunning = true
    m._ilinkToken = "token"
    m._cursor = "cursor-1"
    const gen = ++m._pollGen
    void m.pollLoop(gen)

    const deadline = Date.now() + 5000
    while (calls === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(calls).toBe(1)

    const state = join(dir, "ilink_state.json")
    expect(existsSync(state)).toBe(false)

    const res = await deleteSession("wechat", tmp.path)
    expect(res.status).toBe(200)

    gate.release({ messages: [], cursor: "cursor-2", expired: false })
    await Bun.sleep(50)

    expect(calls).toBe(1)
    expect(existsSync(state)).toBe(false)
    expect(m._pollRunning).toBe(false)
  })

  test("wechat: stop after delete does not resurrect ilink state", async () => {
    await using tmp = await tmpdir()
    const m = WeChatManager as any
    const dir = platformDir("wechat")
    await mkdir(dir, { recursive: true })
    m._initialized = false
    m._pollRunning = true
    m._ilinkToken = "token"
    m._cursor = "cursor-1"

    const res = await deleteSession("wechat", tmp.path)
    expect(res.status).toBe(200)
    const state = join(dir, "ilink_state.json")
    expect(existsSync(state)).toBe(false)

    await Instance.provide({ directory: tmp.path, create: false, fn: () => m.stop() })
    await Instance.provide({ directory: tmp.path, create: false, fn: () => m.stop() })

    expect(existsSync(state)).toBe(false)
    expect(await m.hasCredentials()).toBe(false)
    expect(m._ilinkToken).toBe("")
    expect(m._cursor).toBe("")
  })

  test("wechat: poll loop body save points are generation-guarded", async () => {
    await using tmp = await tmpdir()
    freshGate()
    const m = WeChatManager as any
    let calls = 0
    mock.module("../../src/mobile/ilink", () => ({
      ...ilink,
      getUpdates: () => {
        calls++
        return gate.promise
      },
    }))

    const original = m.saveILinkState.bind(m)
    let saveCalls = 0
    let parked = false
    let releaseHold = () => {}
    const hold = new Promise<void>((r) => (releaseHold = r))
    spyOn(m, "saveILinkState").mockImplementation(async () => {
      saveCalls++
      await original()
      if (saveCalls === 1) {
        parked = true
        await hold
      }
    })

    const dir = platformDir("wechat")
    await mkdir(dir, { recursive: true })
    m._initialized = false
    m._pollRunning = true
    m._ilinkToken = "token"
    m._cursor = "cursor-1"
    const gen = ++m._pollGen
    void m.pollLoop(gen)

    const deadline = Date.now() + 5000
    while (calls === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(calls).toBe(1)

    gate.release({
      messages: [
        { from_user_id: "u1", message_id: 101, item_list: [{ type: 1, text_item: { text: "a" } }] },
        { from_user_id: "u1", message_id: 102, item_list: [{ type: 1, text_item: { text: "b" } }] },
      ],
      cursor: "cursor-2",
      expired: false,
    })
    while (!parked && Date.now() < deadline) await Bun.sleep(10)
    expect(parked).toBe(true)

    const state = join(dir, "ilink_state.json")
    expect(existsSync(state)).toBe(true)

    const res = await deleteSession("wechat", tmp.path)
    expect(res.status).toBe(200)
    expect(existsSync(state)).toBe(false)

    releaseHold()
    await Bun.sleep(50)

    expect(existsSync(state)).toBe(false)
    expect(calls).toBe(1)
    expect(m._pollRunning).toBe(false)
  })

  test("wechat: reconnect chain is generation-guarded so delete wins", async () => {
    await using tmp = await tmpdir()
    freshGate()
    const m = WeChatManager as any
    mock.module("../../src/mobile/ilink", () => ({
      ...ilink,
      getUpdates: () => gate.promise,
    }))

    const dir = platformDir("wechat")
    await mkdir(dir, { recursive: true })
    const path = join(dir, "ilink_state.json")
    await Bun.write(path, JSON.stringify({ token: "token", cursor: "cursor-1", baseUrl: "https://ilink.example" }))

    const original = m.loadILinkState.bind(m)
    let parked = false
    let releaseHold = () => {}
    const hold = new Promise<void>((r) => (releaseHold = r))
    spyOn(m, "loadILinkState").mockImplementation(async () => {
      const state = await original()
      parked = true
      await hold
      return state
    })

    await Instance.provide({
      directory: tmp.path,
      create: false,
      fn: () => {
        void m.reconnect(m._pollGen)
      },
    })

    const deadline = Date.now() + 5000
    while (!parked && Date.now() < deadline) await Bun.sleep(10)
    expect(parked).toBe(true)

    const res = await deleteSession("wechat", tmp.path)
    expect(res.status).toBe(200)
    expect(existsSync(path)).toBe(false)

    releaseHold()
    await Bun.sleep(50)

    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(dir, "session.json"))).toBe(false)
    expect(m._pollRunning).toBe(false)
    expect(m.status).toBe("idle")
    expect(m._wcSession).toBe(null)
    expect(m._qrcode).toBe(null)
  })
})
