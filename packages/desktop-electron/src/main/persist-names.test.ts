import { describe, expect, test } from "bun:test"
import { LEGACY_SETTINGS_STORE, SETTINGS_STORE, legacyStoreName, storeName, valid } from "./persist-names"

describe("persist names", () => {
  test("maps settings store to aether", () => {
    expect(storeName(LEGACY_SETTINGS_STORE)).toBe(SETTINGS_STORE)
    expect(legacyStoreName(SETTINGS_STORE)).toBe(LEGACY_SETTINGS_STORE)
  })

  test("maps scoped dat files to aether", () => {
    expect(storeName("opencode.global.dat")).toBe("aether.global.dat")
    expect(storeName("opencode.workspace.foo.dat")).toBe("aether.workspace.foo.dat")
    expect(legacyStoreName("aether.global.dat")).toBe("opencode.global.dat")
  })

  test("leaves neutral names unchanged", () => {
    expect(storeName("default.dat")).toBe("default.dat")
    expect(legacyStoreName("default.dat")).toBeUndefined()
  })
})

describe("store name validation", () => {
  test("accepts every name the app uses", () => {
    const names = [
      SETTINGS_STORE,
      LEGACY_SETTINGS_STORE,
      "default.dat",
      "opencode.global.dat",
      "aether.global.dat",
      "opencode.workspace.abcdefgh1234.1a2b3c.dat",
      "aether.workspace.x.y.dat",
      ".hidden",
      "a..b.dat",
    ]
    for (const name of names) expect(valid(name)).toBe(true)
  })

  test("rejects traversal and non-name inputs", () => {
    const names: unknown[] = [
      "",
      "..",
      ".",
      "../../.config/aether/update-config.jsonc",
      "a/../../b.dat",
      "..\\evil.dat",
      "C:\\Users\\x\\evil",
      "/etc/passwd",
      "..dat\\..\\x",
      42,
      null,
      undefined,
      {},
    ]
    for (const name of names) expect(valid(name)).toBe(false)
  })
})
