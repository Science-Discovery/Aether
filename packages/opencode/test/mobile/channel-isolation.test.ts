import { describe, expect, test } from "bun:test"
import path from "path"
import { channelSlug, platformDir, scopedPlatformDir } from "../../src/persist/naming"

describe("mobile channel isolation", () => {
  test("different channels resolve to different platform dirs", () => {
    const prod = scopedPlatformDir("prod", "qq")
    const local = scopedPlatformDir("local", "qq")
    expect(prod).not.toBe(local)
    expect(prod.endsWith(path.join("aether", "prod", "qq"))).toBe(true)
    expect(local.endsWith(path.join("aether", "local", "qq"))).toBe(true)
  })

  test("platforms of one channel share the channel root", () => {
    expect(path.dirname(scopedPlatformDir("prod", "qq"))).toBe(path.dirname(scopedPlatformDir("prod", "wechat")))
    expect(path.dirname(scopedPlatformDir("prod", "qq"))).toBe(path.dirname(scopedPlatformDir("prod", "feishu")))
  })

  test("latest channel keeps the unscoped path", () => {
    const latest = scopedPlatformDir("latest", "wechat")
    expect(latest).not.toBe(scopedPlatformDir("prod", "wechat"))
    expect(latest.endsWith(path.join("aether", "wechat"))).toBe(true)
  })

  test("platformDir follows the runtime channel slug", () => {
    expect(platformDir("feishu")).toBe(scopedPlatformDir(channelSlug(), "feishu"))
  })
})
