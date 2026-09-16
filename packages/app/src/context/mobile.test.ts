import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  bindEmitter,
  bindResolver,
  enabled,
  error,
  fetchStatus,
  hasConfig,
  locked,
  setStatus,
  startBridge,
  status,
  stopBridge,
  user,
  type MobilePlatform,
} from "./mobile"

type FetchMock = (url: string, init?: RequestInit) => { status?: number; body: unknown }

let responder: FetchMock = () => ({ body: {} })
const originalFetch = globalThis.fetch

function jsonResponse(mock: ReturnType<FetchMock>) {
  return new Response(JSON.stringify(mock.body), {
    status: mock.status ?? 200,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url)
    return jsonResponse(responder(url, init))
  }) as typeof fetch
  bindResolver(() => ({ url: "http://test.local", headers: {} }))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setStatus("wechat", "idle")
  setStatus("feishu", "idle")
  setStatus("qq", "idle")
})

let eventHandler: ((ev: { name: string; details: { type: string; properties: any } }) => void) | null = null
bindEmitter({
  listen: (cb) => {
    eventHandler = cb
    return () => {}
  },
})

function emit(type: string, properties: any = {}) {
  eventHandler?.({ name: "test", details: { type, properties } })
}

describe("mobile state machine", () => {
  test("startBridge marks wechat connected on resume response", async () => {
    responder = (url) =>
      url.endsWith("/start")
        ? { body: { success: true, status: "connected", user: { id: "u1", name: "测试" } } }
        : { body: {} }
    await startBridge("wechat")
    expect(status("wechat")).toBe("connected")
    expect(enabled("wechat")).toBe(true)
    expect(user("wechat")?.id).toBe("u1")
  })

  test("startBridge locked response flags locked and stays idle", async () => {
    responder = (url) => (url.endsWith("/start") ? { body: { success: false, code: "locked" } } : { body: {} })
    await startBridge("wechat")
    expect(locked("wechat")).toBe(true)
    expect(status("wechat")).toBe("idle")
  })

  test("startBridge config_missing enters config state", async () => {
    responder = (url) => (url.endsWith("/start") ? { body: { success: false, code: "config_missing" } } : { body: {} })
    await startBridge("feishu")
    expect(status("feishu")).toBe("config")
  })

  test("startBridge failure surfaces error", async () => {
    responder = (url) =>
      url.endsWith("/start") ? { body: { success: false, code: "x", message: "boom" } } : { body: {} }
    await startBridge("qq")
    expect(status("qq")).toBe("error")
    expect(error("qq")?.message).toBe("boom")
  })

  test("fetchStatus syncs idle with config and enabled flag", async () => {
    setStatus("wechat", "qrcode")
    responder = (url) =>
      url.endsWith("/status") ? { body: { status: "idle", enabled: true, hasConfig: true, user: null } } : { body: {} }
    await fetchStatus("wechat")
    expect(status("wechat")).toBe("idle")
    expect(enabled("wechat")).toBe(true)
    expect(hasConfig("wechat")).toBe(true)
  })

  test("stopBridge resets to idle and disabled", async () => {
    responder = (url) => (url.endsWith("/stop") ? { body: { success: true } } : { body: {} })
    setStatus("wechat", "connected")
    await stopBridge("wechat")
    expect(status("wechat")).toBe("idle")
    expect(enabled("wechat")).toBe(false)
  })

  test("connected event sets user and enabled", () => {
    emit("wechat.connected", { user: { id: "u2", name: "二" } })
    expect(status("wechat")).toBe("connected")
    expect(enabled("wechat")).toBe(true)
    expect(user("wechat")?.name).toBe("二")
  })

  test("idle status event is ignored while connected", () => {
    setStatus("wechat", "connected")
    emit("wechat.status", { status: "idle" })
    expect(status("wechat")).toBe("connected")
  })

  test("reconnecting event updates status and message", () => {
    emit("wechat.reconnecting", {})
    expect(status("wechat")).toBe("reconnecting")
  })

  test("error event surfaces code and message", () => {
    emit("wechat.error", { code: "login_failed", message: "bad token" })
    expect(status("wechat")).toBe("error")
    expect(error("wechat")?.code).toBe("login_failed")
  })

  test("qrcode event stores image", () => {
    emit("wechat.qrcode", { image: "data:image/png;base64,xyz" })
    expect(status("wechat")).toBe("qrcode")
  })
})
