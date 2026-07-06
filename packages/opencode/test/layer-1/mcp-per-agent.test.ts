import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Layer 1 — MCP per-agent config", () => {
  test("mcp from config populates Agent.Info.mcp", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            mcp: {
              "research-conventions": true,
              "research-state": true,
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.mcp).toEqual({
          "research-conventions": true,
          "research-state": true,
        })
      },
    })
  })

  test("mcp not in options (knownKeys whitelist)", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            mcp: {
              "research-conventions": true,
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.options["mcp"]).toBeUndefined()
        expect(general?.mcp).toEqual({ "research-conventions": true })
      },
    })
  })

  test("agent without mcp config sees all MCP tools (backward compatible)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(build?.mcp).toBeUndefined()
      },
    })
  })

  test("MCP tool ID prefix derivation: server name → sanitized prefix", () => {
    const serverName = "research-conventions"
    const sanitized = serverName.replace(/[^a-zA-Z0-9_-]/g, "_")
    const prefix = sanitized + "_"
    expect(prefix).toBe("research-conventions_")
    expect("research-conventions_convention_lock_status".startsWith(prefix)).toBe(true)
    expect("research_state_get_status".startsWith(prefix)).toBe(false)
  })

  test("MCP tool ID prefix derivation: server name with special chars", () => {
    const serverName = "my.mcp.server"
    const sanitized = serverName.replace(/[^a-zA-Z0-9_-]/g, "_")
    const prefix = sanitized + "_"
    expect(prefix).toBe("my_mcp_server_")
    expect("my_mcp_server_tool_name".startsWith(prefix)).toBe(true)
  })

  test("mcp filter: only enabled=true servers are allowed", () => {
    const mcp = {
      "research-conventions": true,
      "research-state": true,
      "dangerous-server": false,
    }
    const allowedPrefixes = Object.entries(mcp)
      .filter(([_, enabled]) => enabled)
      .map(([serverId]) => serverId.replace(/[^a-zA-Z0-9_-]/g, "_") + "_")
    expect(allowedPrefixes).toEqual(["research-conventions_", "research-state_"])
    expect(allowedPrefixes).not.toContain("dangerous-server_")
  })

  test("mcp filter: false value has no distinct meaning (equivalent to omit)", () => {
    const mcpWithFalse = { "research-conventions": true, other: false }
    const allowedPrefixes = Object.entries(mcpWithFalse)
      .filter(([_, enabled]) => enabled)
      .map(([serverId]) => serverId.replace(/[^a-zA-Z0-9_-]/g, "_") + "_")
    const mcpWithoutOther = { "research-conventions": true }
    const allowedPrefixes2 = Object.entries(mcpWithoutOther)
      .filter(([_, enabled]) => enabled)
      .map(([serverId]) => serverId.replace(/[^a-zA-Z0-9_-]/g, "_") + "_")
    expect(allowedPrefixes).toEqual(allowedPrefixes2)
  })
})
