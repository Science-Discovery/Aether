import { describe, expect, test } from "bun:test"
import { forget, fresh, known, remember } from "./directory-guard"

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

  test("matches UNC directories with different separators", () => {
    expect(known("//server/share/Paper", ["\\\\server\\share\\Paper"])).toBe(true)
    expect(known("\\\\server\\share\\Paper\\", ["//server/share/Paper/"])).toBe(true)
    expect(known("\\\\server\\share", ["//server/share/"])).toBe(true)
  })

  test("keeps UNC shares and parent segments distinct", () => {
    expect(known("//server/other/Paper", ["\\\\server\\share\\Paper"])).toBe(false)
    expect(known("//server/share/Paper/../Other", ["\\\\server\\share\\Other"])).toBe(false)
    expect(known("//Server/share/Paper", ["\\\\server\\share\\Paper"])).toBe(false)
  })

  test("does not reinterpret POSIX backslashes or Windows device paths as UNC", () => {
    expect(known("//server/share/a\\b", ["\\\\server\\share\\a\\b"])).toBe(false)
    expect(known("/server/share/Paper", ["\\\\server\\share\\Paper"])).toBe(false)
    expect(known("//?/C:/Paper", ["\\\\?\\C:\\Paper"])).toBe(false)
    expect(known("//./C:/Paper", ["\\\\.\\C:\\Paper"])).toBe(false)
  })
})

describe("directory guard cache", () => {
  test("validates remembered directories per server until cleared", () => {
    forget()
    expect(fresh("local", "F:\\Desktop\\Paper")).toBe(false)
    remember("local", ["F:/Desktop/Paper"])
    expect(fresh("local", "F:\\Desktop\\Paper")).toBe(true)
    expect(fresh("local", "F:/Desktop/Paper/")).toBe(true)
    expect(fresh("local", "F:/Desktop/Other")).toBe(false)
    expect(fresh("remote", "F:\\Desktop\\Paper")).toBe(false)
    forget()
    expect(fresh("local", "F:\\Desktop\\Paper")).toBe(false)
  })

  test("forgets a single server without touching others", () => {
    forget()
    remember("local", ["F:/Desktop/Paper"])
    remember("remote", ["F:/Desktop/Paper"])
    forget("local")
    expect(fresh("local", "F:\\Desktop\\Paper")).toBe(false)
    expect(fresh("remote", "F:\\Desktop\\Paper")).toBe(true)
    forget()
    expect(fresh("remote", "F:\\Desktop\\Paper")).toBe(false)
  })
})
