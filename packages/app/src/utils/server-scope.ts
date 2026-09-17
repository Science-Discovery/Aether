import { checksum } from "@opencode-ai/util/encode"

export function isLocalServerKey(server: string | undefined) {
  if (!server) return true
  if (server === "sidecar") return true
  const host = server.replace(/^https?:\/\//, "").split(":")[0]
  return host === "localhost" || host === "127.0.0.1"
}

export function serverHash(server: string | undefined) {
  if (!server || isLocalServerKey(server)) return
  return checksum(server) ?? "0"
}
