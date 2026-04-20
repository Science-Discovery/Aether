import { ServerConnection } from "@/context/server"
import type { ServerHealth } from "@/utils/server-health"

export type ServerGroup = "other" | "ssh"

export const serverGroups: ServerGroup[] = ["other", "ssh"]

export function serverGroup(conn: ServerConnection.Any): ServerGroup {
  return conn.type === "ssh" ? "ssh" : "other"
}

export function sortServers(
  list: ServerConnection.Any[],
  active: ServerConnection.Key | undefined,
  status: Record<ServerConnection.Key, ServerHealth | undefined>,
) {
  if (!list.length) return list
  const order = new Map(list.map((conn, idx) => [conn, idx] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }

  return list.slice().sort((a, b) => {
    const aKey = ServerConnection.key(a)
    const bKey = ServerConnection.key(b)
    const group = serverGroups.indexOf(serverGroup(a)) - serverGroups.indexOf(serverGroup(b))
    if (group !== 0) return group
    if (aKey === active) return -1
    if (bKey === active) return 1
    const health = rank(status[aKey]) - rank(status[bKey])
    if (health !== 0) return health
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

export function splitServers(list: ServerConnection.Any[]) {
  return serverGroups
    .map((category) => ({
      category,
      items: list.filter((conn) => serverGroup(conn) === category),
    }))
    .filter((group) => group.items.length > 0)
}
