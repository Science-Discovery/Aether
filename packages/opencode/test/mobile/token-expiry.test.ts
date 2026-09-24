import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync } from "fs"
import { mkdir, rm } from "fs/promises"
import { join } from "path"
import { WeChatManager } from "../../src/mobile/wechat"
import * as ilink from "../../src/mobile/ilink"
import type { PollResult } from "../../src/mobile/ilink"
import { Instance } from "../../src/project/instance"
import { platformDir } from "../../src/persist/naming"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

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

const pending: ((v: PollResult) => void)[] = []

function releasePending(v: Partial<PollResult>) {
  for (const r of pending.splice(0)) r({ messages: [], cursor: "", expired: false, ...v })
}

beforeEach(async () => {
  await rm(platformDir("wechat"), { recursive: true, force: true })
})

afterEach(async () => {
  releasePending({})
  mock.restore()
  const m = WeChatManager as any
  m._pollRunning = false
  m._pollGen = 0
  m._ilinkToken = ""
  m._cursor = ""
  m._loginAbort = null
  m._tokenKnownExpired = false
  m._wcSession = null
  m._qrcode = null
  m._status = "idle"
  m.resumeDelay = 60 * 60 * 1000
  m.unsubscribeBusEvents()
  await Instance.disposeAll()
  await resetDatabase()
})

async function waitUntil(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}

const statePath = () => join(platformDir("wechat"), "ilink_state.json")

async function startPolling(token: string, cursor: string) {
  const m = WeChatManager as any
  m._initialized = false
  m._pollRunning = true
  m._ilinkToken = token
  m._cursor = cursor
  const gen = ++m._pollGen
  await mkdir(platformDir("wechat"), { recursive: true })
  void m.pollLoop(gen)
  return m
}

function haltLoop(m: any) {
  m._pollRunning = false
  m._pollGen++
}

function parkPoll(): Promise<PollResult> {
  return new Promise<PollResult>((r) => pending.push((v) => r(v)))
}

function mockPoll(script: (calls: number) => Promise<PollResult> | PollResult, qr?: () => Promise<unknown>) {
  let calls = 0
  mock.module("../../src/mobile/ilink", () => ({
    ...ilink,
    getUpdates: () => {
      calls++
      return Promise.resolve().then(() => script(calls))
    },
    requestQRCode: async () => {
      if (qr) await qr()
      throw new Error("QR login must not be triggered by token expiry")
    },
  }))
  return () => calls
}

describe("wechat token expiry", () => {
  test("-14 keeps the token and silently resumes without QR", async () => {
    const m = WeChatManager as any
    m.resumeDelay = 120
    let qrCalls = 0
    const calls = mockPoll(
      () => parkPoll(),
      async () => {
        qrCalls++
        throw new Error("QR login must not be triggered by token expiry")
      },
    )

    await startPolling("token-a", "cursor-1")
    await waitUntil(() => calls() === 1)

    releasePending({ cursor: "cursor-x", expired: true })
    await waitUntil(() => m.status === "reconnecting")

    expect(m._tokenKnownExpired).toBe(true)
    expect(m._ilinkToken).toBe("token-a")
    expect(m._pollRunning).toBe(false)
    expect(existsSync(statePath())).toBe(true)
    const saved = JSON.parse(await Bun.file(statePath()).text())
    expect(saved.token).toBe("token-a")
    expect(saved.cursor).toBe("")
    expect(await m.hasCredentials()).toBe(true)
    expect(qrCalls).toBe(0)

    await waitUntil(() => calls() === 2)
    expect(m.status).toBe("connected")
    expect(m._ilinkToken).toBe("token-a")
    expect(m._cursor).toBe("")
    expect(qrCalls).toBe(0)

    haltLoop(m)
    releasePending({})
    await Bun.sleep(50)
    expect(calls()).toBe(2)
  })

  test("401 keeps the token and follows the same silent resume path", async () => {
    const m = WeChatManager as any
    m.resumeDelay = 120
    let qrCalls = 0
    const calls = mockPoll(
      (n) => {
        if (n === 1) throw new Error("ilink 401: unauthorized")
        return parkPoll()
      },
      async () => {
        qrCalls++
        throw new Error("QR login must not be triggered by token expiry")
      },
    )

    await startPolling("token-b", "cursor-1")
    await waitUntil(() => m.status === "reconnecting")

    expect(m._ilinkToken).toBe("token-b")
    expect(existsSync(statePath())).toBe(true)
    expect(await m.hasCredentials()).toBe(true)
    expect(qrCalls).toBe(0)

    await waitUntil(() => calls() === 2)
    expect(m.status).toBe("connected")
    expect(m._ilinkToken).toBe("token-b")

    haltLoop(m)
    releasePending({})
    await Bun.sleep(50)
    expect(calls()).toBe(2)
  })

  test("stop during the pause window cancels the silent resume", async () => {
    const m = WeChatManager as any
    m.resumeDelay = 150
    const calls = mockPoll(() => parkPoll())

    await startPolling("token-c", "cursor-1")
    await waitUntil(() => calls() === 1)

    releasePending({ cursor: "cursor-x", expired: true })
    await waitUntil(() => m.status === "reconnecting")
    expect(existsSync(statePath())).toBe(true)

    await Instance.provide({
      directory: root,
      create: false,
      fn: () => m.stop(),
    })

    await Bun.sleep(300)
    expect(calls()).toBe(1)
    expect(m._pollRunning).toBe(false)
    expect(m._tokenKnownExpired).toBe(true)
    expect(m.status).toBe("idle")
  })

  test("retry during the pause clears credentials and shows QR", async () => {
    const m = WeChatManager as any
    m.resumeDelay = 60 * 60 * 1000
    let qrCalls = 0
    const calls = mockPoll(
      () => parkPoll(),
      async () => {
        qrCalls++
        throw new Error("QR login aborted")
      },
    )

    await startPolling("token-d", "cursor-1")
    await waitUntil(() => calls() === 1)

    releasePending({ cursor: "cursor-x", expired: true })
    await waitUntil(() => m.status === "reconnecting")
    expect(existsSync(statePath())).toBe(true)

    await Instance.provide({
      directory: root,
      create: false,
      fn: () => m.retry(),
    })

    expect(existsSync(statePath())).toBe(false)
    expect(await m.hasCredentials()).toBe(false)
    expect(m._ilinkToken).toBe("")
    await waitUntil(() => qrCalls === 1)
  })

  test("start resumes silently from the saved token even without session.json", async () => {
    const m = WeChatManager as any
    let qrCalls = 0
    const calls = mockPoll(
      () => parkPoll(),
      async () => {
        qrCalls++
        throw new Error("QR login must not be triggered when a token is saved")
      },
    )

    await mkdir(platformDir("wechat"), { recursive: true })
    await Bun.write(
      statePath(),
      JSON.stringify({ token: "token-e", cursor: "cursor-1", baseUrl: "https://ilink.example" }),
    )
    m._pollGen = 0
    m._pollRunning = false
    m._status = "idle"

    const result = await Instance.provide({
      directory: root,
      create: false,
      fn: () => m.start(),
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe("connected")
    expect(m.status).toBe("connected")
    expect(m._ilinkToken).toBe("token-e")
    expect(qrCalls).toBe(0)
    await waitUntil(() => calls() === 1)

    haltLoop(m)
    releasePending({})
    await Bun.sleep(50)
    expect(calls()).toBe(1)
  })

  test("expired resume cycle re-arms after a second -14", async () => {
    const m = WeChatManager as any
    m.resumeDelay = 100
    let qrCalls = 0
    const calls = mockPoll(
      (n) => {
        if (n <= 2) return { messages: [], cursor: `cursor-${n}`, expired: true }
        return parkPoll()
      },
      async () => {
        qrCalls++
        throw new Error("QR login must not be triggered by token expiry")
      },
    )

    await startPolling("token-f", "cursor-1")
    await waitUntil(() => calls() === 3)
    expect(m.status).toBe("connected")
    expect(m._ilinkToken).toBe("token-f")
    expect(m._cursor).toBe("")
    expect(qrCalls).toBe(0)

    haltLoop(m)
    releasePending({})
    await Bun.sleep(50)
    expect(calls()).toBe(3)
  })
})
