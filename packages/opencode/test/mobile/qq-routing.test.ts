import { beforeEach, describe, expect, test } from "bun:test"
import { QQManager } from "../../src/mobile/qq"

describe("qq reply routing", () => {
  beforeEach(() => {
    QQManager._msgChats.clear()
    QQManager._currentChatId = ""
  })

  test("routes replies by originating message id", () => {
    QQManager.trackChat("msg_a", "c2c_alice")
    QQManager.trackChat("msg_b", "group_bob")
    expect(QQManager.chatFor("msg_a")).toBe("c2c_alice")
    expect(QQManager.chatFor("msg_b")).toBe("group_bob")
  })

  test("falls back to last chat for unknown message ids", () => {
    QQManager.trackChat("msg_a", "c2c_alice")
    expect(QQManager.chatFor("msg_unknown")).toBe("c2c_alice")
    expect(QQManager.chatFor("msg_unknown")).toBe(QQManager._currentChatId)
  })

  test("evicts oldest mappings beyond the cap", () => {
    for (let i = 0; i < 600; i++) QQManager.trackChat(`msg_${i}`, `chat_${i}`)
    expect(QQManager._msgChats.size).toBeLessThanOrEqual(500)
    expect(QQManager.chatFor("msg_599")).toBe("chat_599")
    expect(QQManager.chatFor("msg_0")).toBe(QQManager._currentChatId)
  })
})
