import { describe, expect, test } from "bun:test"

const INSTALL_DIR_RE = /aether[/\\]aether_\d+\.\d+\.\d+\.\d+/i

function shouldRedirect(dir: string): boolean {
  return INSTALL_DIR_RE.test(dir)
}

describe("install directory detection", () => {
  test("matches Windows Aether install path", () => {
    expect(shouldRedirect("C:\\Users\\user\\AppData\\Local\\Programs\\aether\\aether_0.6.2.33")).toBe(true)
    expect(shouldRedirect("C:\\Users\\user\\AppData\\Local\\Programs\\aether\\aether_0.6.2.44")).toBe(true)
  })

  test("matches forward-slash normalized install path", () => {
    expect(shouldRedirect("C:/Users/user/AppData/Local/Programs/aether/aether_0.6.2.33")).toBe(true)
  })

  test("matches lowercase install path", () => {
    expect(shouldRedirect("c:/users/user/appdata/local/programs/aether/aether_0.6.2.33")).toBe(true)
  })

  test("matches install dir nested inside longer path", () => {
    expect(shouldRedirect("/some/prefix/aether/aether_1.2.3.4/more")).toBe(true)
  })

  test("does not match normal project directory", () => {
    expect(shouldRedirect("E:\\work\\AI\\Aether\\session-preference")).toBe(false)
    expect(shouldRedirect("E:\\work\\AI\\Aether\\debug")).toBe(false)
    expect(shouldRedirect("C:\\Users\\user\\projects\\my-app")).toBe(false)
  })

  test("does not match aether dir without version subdir", () => {
    expect(shouldRedirect("/usr/local/aether")).toBe(false)
    expect(shouldRedirect("C:\\aether\\data")).toBe(false)
  })

  test("does not match version string without aether parent", () => {
    expect(shouldRedirect("/tmp/aether_0.6.2.33")).toBe(false)
  })

  test("does not match empty string", () => {
    expect(shouldRedirect("")).toBe(false)
  })
})
