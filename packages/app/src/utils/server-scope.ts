import { checksum } from "@opencode-ai/util/encode"

export function isLocalServerKey(server: string | undefined) {
  if (!server) return true
  if (server === "sidecar") return true
  const host = server.replace(/^https?:\/\//, "").split(":")[0]
  return host === "localhost" || host === "127.0.0.1"
}

export function serverHash(server: string | undefined) {
  if (isLocalServerKey(server)) return
  if (!server) return
  return checksum(server) ?? "0"
}

export function serverScopedKey(key: string, server: string | undefined) {
  const hash = serverHash(server)
  if (!hash) return key
  return `${key}\nserver:${hash}`
}

export function serverSessionKey(dir: string | undefined, id: string | undefined, server: string | undefined) {
  const base = `${dir ?? ""}${id ? "/" + id : ""}`
  const hash = serverHash(server)
  if (!hash) return base
  return `${base}//server:${hash}`
}
