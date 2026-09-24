import { describe, expect, test } from "bun:test"
import { sessionTitle } from "../../src/mobile/base"

const CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

function titleOf(name: string, now?: Date, ...rands: number[]): string {
  let i = 0
  return sessionTitle(name, now, () => rands[i++])
}

describe("mobile session title", () => {
  test("matches platform + random suffix + second-precision ISO time format", () => {
    const now = new Date("2026-09-24T09:22:46.817Z")
    for (const name of ["QQ", "微信", "飞书"]) {
      const title = sessionTitle(name, now)
      expect(title).toMatch(new RegExp(`^${name}对话[0-9a-zA-Z]{4}-\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$`))
    }
  })

  test("drops millisecond tail and timezone marker", () => {
    const title = titleOf("QQ", new Date("2026-09-24T09:22:46.817Z"), 0, 0, 0, 0)
    expect(title).toBe("QQ对话0000-2026-09-24T09:22:46")
  })

  test("rand at extremes maps to first and last charset chars", () => {
    expect(titleOf("QQ", undefined, 0, 0, 0, 0).slice(4, 8)).toBe("0000")
    expect(titleOf("QQ", undefined, 0.9999999999, 0.9999999999, 0.9999999999, 0.9999999999).slice(4, 8)).toBe("ZZZZ")
  })

  test("rand sequence picks exact charset characters", () => {
    const title = titleOf("QQ", undefined, 0, 0.5, 35.5 / 62, 1 - Number.EPSILON)
    expect(title.slice(4, 8)).toBe("0" + CHARS[31] + CHARS[35] + CHARS[61])
  })

  test("titles generated in the same second still differ in suffix", () => {
    const now = new Date("2026-09-24T09:22:46.817Z")
    const suffixes = new Set(Array.from({ length: 50 }, () => sessionTitle("QQ", now).slice(4, 8)))
    expect(suffixes.size).toBeGreaterThan(1)
  })

  test("defaults pick current time", () => {
    const before = new Date().toISOString().slice(0, 19)
    const title = sessionTitle("QQ")
    const after = new Date().toISOString().slice(0, 19)
    const time = title.slice(9)
    expect(time >= before).toBe(true)
    expect(time <= after).toBe(true)
  })
})
