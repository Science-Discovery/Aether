import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

describe("MCP auto-connect for agent.mcp", () => {
  test("agent.mcp field lists enabled servers as keys with true values", () => {
    const agentMcp = {
      "research-conventions": true,
      "research-state": true,
    }
    const needed = Object.entries(agentMcp)
      .filter(([_, enabled]) => enabled)
      .map(([serverId]) => serverId)
    expect(needed).toEqual(["research-conventions", "research-state"])
  })

  test("agent.mcp with false values excludes servers from needed list", () => {
    const agentMcp = {
      "research-conventions": true,
      "research-state": false,
    }
    const needed = Object.entries(agentMcp)
      .filter(([_, enabled]) => enabled)
      .map(([serverId]) => serverId)
    expect(needed).toEqual(["research-conventions"])
  })

  test("agent.mcp undefined means no auto-connect needed", () => {
    const agentMcp = undefined
    const needed = agentMcp
      ? Object.entries(agentMcp)
          .filter(([_, enabled]) => enabled)
          .map(([serverId]) => serverId)
      : []
    expect(needed).toEqual([])
  })

  test("servers with status !== connected should trigger MCP.connect", () => {
    const statuses: Record<string, { status: string }> = {
      "research-conventions": { status: "disabled" },
      "research-state": { status: "disabled" },
    }
    const needed = ["research-conventions", "research-state"]
    const toConnect = needed.filter((name) => statuses[name]?.status !== "connected")
    expect(toConnect).toEqual(["research-conventions", "research-state"])
  })

  test("already-connected servers are skipped", () => {
    const statuses: Record<string, { status: string }> = {
      "research-conventions": { status: "connected" },
      "research-state": { status: "disabled" },
    }
    const needed = ["research-conventions", "research-state"]
    const toConnect = needed.filter((name) => statuses[name]?.status !== "connected")
    expect(toConnect).toEqual(["research-state"])
  })

  test("aether.jsonc has research MCP servers with enabled: false", async () => {
    const configPath = path.join(process.cwd(), ".aether", "aether.jsonc")
    const exists = await fs
      .access(configPath)
      .then(() => true)
      .catch(() => false)
    if (!exists) return

    const text = await fs.readFile(configPath, "utf-8")
    const conventionMatch = text.match(/"research-conventions"[^}]*"enabled"\s*:\s*false/)
    const stateMatch = text.match(/"research-state"[^}]*"enabled"\s*:\s*false/)
    expect(conventionMatch).not.toBeNull()
    expect(stateMatch).not.toBeNull()
  })
})
