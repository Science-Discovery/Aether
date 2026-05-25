import type { ServerConnection } from "@/context/server"

export type SshLanding = {
  rootDirectory: string
  directory: string
  sessionID: string | null
  workspaceID: string | null
}

export type SshBootstrap = {
  savedHostID: string
  runtimeID: string
  endpoint: ServerConnection.HttpBase
  version: {
    chosen: string
    source: "exact" | "fallback"
  }
  landing: SshLanding
  logs: string[]
  reused: boolean
}

function auth(http: ServerConnection.HttpBase) {
  const headers: Record<string, string> = {}
  if (!http.password) return headers
  headers.Authorization = `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
  return headers
}

const consumerID = (() => {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
})()

export async function bootstrapSsh(server: ServerConnection.HttpBase, input: {
  savedHostID: string
  host: string
  command: string
  installDir: string
  password?: string
}) {
  const res = await fetch(new URL("/experimental/ssh/bootstrap", server.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...auth(server),
    },
    body: JSON.stringify({
      ...input,
      consumerID,
    }),
  })
  const data = await res.json().catch(() => undefined)
  if (!res.ok) {
    const message =
      typeof data?.message === "string"
        ? data.message
        : typeof data?.error?.message === "string"
          ? data.error.message
          : `Request failed: ${res.status}`
    throw new Error(message)
  }
  return data as SshBootstrap
}

export async function disconnectSsh(server: ServerConnection.HttpBase, savedHostID: string) {
  const res = await fetch(new URL("/experimental/ssh/disconnect", server.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...auth(server),
    },
    body: JSON.stringify({ savedHostID, consumerID }),
  })
  if (!res.ok) throw new Error(`Disconnect failed: ${res.status}`)
  return res.json().catch(() => ({ ok: false })) as Promise<{ ok: boolean }>
}
