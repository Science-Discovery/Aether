import { Flag } from "../flag/flag"

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"])

// Prefix matching used to admit junk like "http://localhost:junk", so loopback
// origins are now matched after URL parsing. Non-http schemes keep their
// explicit comparisons below.
function loopbackOrigin(input: string) {
  if (!URL.canParse(input)) return false
  return LOOPBACK_HOSTNAMES.has(new URL(input).hostname.toLowerCase())
}

// Origin:null is an opaque origin (sandboxed iframe, file:// page) and identifies
// no one. It is only allowed when the server requires authentication, so the
// desktop app's file:// renderer (which holds the password) keeps working while
// unauthenticated opaque origins get no CORS grant. An explicit entry in the
// cors list is an operator decision and always wins.
export function allowOrigin(input: string | undefined, password: string | undefined, extra?: string[]) {
  if (!input) return
  if (extra?.includes(input)) return input
  if (input === "null") {
    if (!password) return
    return input
  }
  if (loopbackOrigin(input)) return input
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost") {
    return input
  }
  if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) return input
}
