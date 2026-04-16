import { describe, expect, test } from "bun:test"
import { LEGACY_SETTINGS_STORE, SETTINGS_STORE, legacyStoreName, storeName } from "./persist-names"

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
