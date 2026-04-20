import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/context/server"
import { serverGroup, sortServers, splitServers } from "@/utils/server-list"

describe("server-list", () => {
  const local: ServerConnection.Http = {
    type: "http",
    displayName: "Local",
    http: { url: "http://localhost:4096" },
  }
  const cloud: ServerConnection.Http = {
    type: "http",
    displayName: "Cloud",
    http: { url: "https://cloud.example.com" },
  }
  const ssh: ServerConnection.Ssh = {
    type: "ssh",
    id: "box",
    host: "dev@box",
    command: "ssh dev@box",
    installDir: "~/.opencode/bin",
    http: { url: "http://127.0.0.1:4097" },
  }

  test("detects ssh servers separately", () => {
    expect(serverGroup(local)).toBe("other")
    expect(serverGroup(ssh)).toBe("ssh")
  })

  test("sorts by group before active and health", () => {
    const status = {
      [ServerConnection.key(local)]: { healthy: false, version: "1.0.0" },
      [ServerConnection.key(cloud)]: { healthy: true, version: "1.0.0" },
      [ServerConnection.key(ssh)]: { healthy: true, version: "1.0.0" },
    }
    const list = sortServers([ssh, local, cloud], ServerConnection.key(local), status)
    expect(list.map((conn) => ServerConnection.key(conn))).toEqual([
      ServerConnection.key(local),
      ServerConnection.key(cloud),
      ServerConnection.key(ssh),
    ])
  })

  test("splits sorted servers into visible groups", () => {
    const groups = splitServers([local, ssh])
    expect(groups).toEqual([
      { category: "other", items: [local] },
      { category: "ssh", items: [ssh] },
    ])
  })
})
