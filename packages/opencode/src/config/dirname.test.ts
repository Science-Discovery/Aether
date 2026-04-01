import { describe, expect, test } from "bun:test"
import { getConfigDirName } from "./dirname"

describe("getConfigDirName", () => {
  test("defaults to .opencode when env variable is not set", () => {
    delete process.env.OPENCODE_CONFIG_DIR_NAME
    const dir = getConfigDirName()
    expect(dir).toBe(".opencode")
  })

  test("uses custom name from OPENCODE_CONFIG_DIR_NAME env variable", () => {
    process.env.OPENCODE_CONFIG_DIR_NAME = ".aether"
    const dir = getConfigDirName()
    expect(dir).toBe(".aether")
    delete process.env.OPENCODE_CONFIG_DIR_NAME
  })

  test("returns .opencode when OPENCODE_CONFIG_DIR_NAME is empty string", () => {
    process.env.OPENCODE_CONFIG_DIR_NAME = ""
    const dir = getConfigDirName()
    expect(dir).toBe(".opencode")
    delete process.env.OPENCODE_CONFIG_DIR_NAME
  })

  test("trims whitespace from env value", () => {
    process.env.OPENCODE_CONFIG_DIR_NAME = "  .myconfig  "
    const dir = getConfigDirName()
    expect(dir).toBe(".myconfig")
    delete process.env.OPENCODE_CONFIG_DIR_NAME
  })
})
