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
})
