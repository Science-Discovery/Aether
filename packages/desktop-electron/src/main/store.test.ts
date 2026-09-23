import { describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let home = ""

const app = {
  isPackaged: false,
  getPath: () => home,
  getVersion: () => "0.0.0",
  setAppLogsPath: () => undefined,
  setName: () => undefined,
  setPath: () => undefined,
}

mock.module("electron", () => ({
  default: { app },
  app,
}))

describe("electron store", () => {
  test("keeps dotted persisted keys as top-level keys", async () => {
    home = mkdtempSync(join(tmpdir(), "aether-store-"))
    process.env.OPENCODE_TEST_HOME = home

    try {
      const mod = await import("./store")
      const item = mod.getStore("opencode.global.dat")

      item.clear()
      item.set("layout", "LAYOUT")
      item.set("layout.page", "PAGE")

      expect(item.store).toEqual({
        layout: "LAYOUT",
        "layout.page": "PAGE",
      })
    } finally {
      delete process.env.OPENCODE_TEST_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("rejects traversal store names before touching disk", async () => {
    home = mkdtempSync(join(tmpdir(), "aether-store-"))
    process.env.OPENCODE_TEST_HOME = home

    try {
      const mod = await import("./store")
      const bad: unknown[] = [
        "../../.config/aether/update-config.jsonc",
        "a/../../b.dat",
        "..\\evil",
        "C:\\Users\\x\\evil",
        "/etc/passwd",
        "",
        "..",
        ".",
        "..\\..\\update-config.jsonc",
        42,
        null,
      ]
      for (const name of bad) expect(() => mod.getStore(name as string)).toThrow()

      const ok = mod.getStore("default.dat")
      expect(ok.path.endsWith("default.dat")).toBe(true)
    } finally {
      delete process.env.OPENCODE_TEST_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })
})
