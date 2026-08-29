import { describe, expect, test } from "bun:test"
import { known } from "./directory-guard"

describe("directory guard", () => {
  test("matches Windows paths with different separators", () => {
    expect(known("F:/Desktop/Paper", ["F:\\Desktop\\Paper"])).toBe(true)
  })

  test("matches equivalent paths with trailing separators", () => {
    expect(known("F:/Desktop/Paper/", ["F:\\Desktop\\Paper\\"])).toBe(true)
  })

  test("blocks directories that are not registered", () => {
    expect(known("F:/Desktop/Other", ["F:\\Desktop\\Paper"])).toBe(false)
  })

  test("keeps POSIX backslashes distinct from separators", () => {
    expect(known("/srv/a\\b", ["/srv/a/b"])).toBe(false)
  })

  test("does not resolve parent segments", () => {
    expect(known("F:/Desktop/Paper/../Other", ["F:\\Desktop\\Other"])).toBe(false)
  })

  test("preserves Windows path casing", () => {
    expect(known("f:/Desktop/Paper", ["F:\\Desktop\\Paper"])).toBe(false)
  })
})
