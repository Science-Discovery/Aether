import { describe, expect, test } from "bun:test"
import { occupied } from "../../src/mobile/supervisor"
import type { Info } from "../../src/server/presence"

const sibling = (mobile?: Record<string, string>): Info => ({
  pid: 999,
  channel: "local",
  clients: { desktop: 0, web: 0 },
  mobile,
})

describe("mobile supervisor sibling arbitration", () => {
  test("sibling without bridge info never blocks", () => {
    expect(occupied([sibling()], "wechat")).toBe(false)
    expect(occupied([sibling({})], "wechat")).toBe(false)
  })

  test("idle and error siblings leave the platform free", () => {
    expect(occupied([sibling({ wechat: "idle" })], "wechat")).toBe(false)
    expect(occupied([sibling({ wechat: "error" })], "wechat")).toBe(false)
  })

  test("starting, connected and reconnecting siblings occupy the platform", () => {
    expect(occupied([sibling({ wechat: "starting" })], "wechat")).toBe(true)
    expect(occupied([sibling({ wechat: "connected" })], "wechat")).toBe(true)
    expect(occupied([sibling({ wechat: "reconnecting" })], "wechat")).toBe(true)
  })

  test("arbitration is per platform", () => {
    const siblings = [sibling({ wechat: "connected", feishu: "idle" })]
    expect(occupied(siblings, "wechat")).toBe(true)
    expect(occupied(siblings, "feishu")).toBe(false)
    expect(occupied(siblings, "qq")).toBe(false)
  })

  test("no siblings means nothing is occupied", () => {
    expect(occupied([], "wechat")).toBe(false)
  })
})
