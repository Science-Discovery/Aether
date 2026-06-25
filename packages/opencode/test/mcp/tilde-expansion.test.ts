import { describe, expect, test } from "bun:test"
import os from "os"
import { MCP } from "../../src/mcp"

describe("expandTilde", () => {
  test("replaces leading ~ with os.homedir() on each element", () => {
    const home = os.homedir()
    expect(MCP.expandTilde(["~/bin/uv", "run", "~/mcp/server.py"])).toEqual([
      `${home}/bin/uv`,
      "run",
      `${home}/mcp/server.py`,
    ])
  })

  test("leaves elements without ~ unchanged", () => {
    expect(MCP.expandTilde(["uv", "run", "/absolute/path/server.py"])).toEqual([
      "uv",
      "run",
      "/absolute/path/server.py",
    ])
  })

  test("only replaces ~ anchored at start of string", () => {
    expect(MCP.expandTilde(["path/with~/middle"])).toEqual(["path/with~/middle"])
  })

  test("does not mutate the input array", () => {
    const cmd = ["~/bin/uv", "run"]
    const copy = [...cmd]
    MCP.expandTilde(cmd)
    expect(cmd).toEqual(copy)
  })

  test("empty array yields empty array", () => {
    expect(MCP.expandTilde([])).toEqual([])
  })

  test("~/.aether/bin/uv expands fully", () => {
    const home = os.homedir()
    expect(MCP.expandTilde(["~/.aether/bin/uv"])).toEqual([`${home}/.aether/bin/uv`])
  })
})
