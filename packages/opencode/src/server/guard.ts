import type { Env, MiddlewareHandler } from "hono"
import { Flag } from "../flag/flag"
import { allowOrigin } from "./origin"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

export function isLoopback(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

function sameHost(origin: string, host: string | undefined) {
  if (!host) return false
  return URL.canParse(origin) && new URL(origin).host === host
}

export function assertBindAllowed(hostname: string) {
  if (Flag.OPENCODE_SERVER_PASSWORD || isLoopback(hostname)) return
  throw new Error(
    `Refusing to listen on ${hostname} without OPENCODE_SERVER_PASSWORD: non-loopback binds require a password`,
  )
}

export const originGuard =
  <E extends Env>(cors?: string[]): MiddlewareHandler<E> =>
  async (c, next) => {
    // Cross-site writes ride on simple requests (no preflight) and
    // WebSocket upgrades bypass CORS entirely. Browsers always attach an
    // unforgable Origin to both, while non-browser clients send none, so
    // rejecting disallowed origins only affects malicious pages.
    const upgrade = c.req.header("upgrade")?.toLowerCase() === "websocket"
    if (!upgrade && SAFE_METHODS.has(c.req.method)) return next()
    const origin = c.req.header("origin")
    if (!origin) return next()
    if (allowOrigin(origin, Flag.OPENCODE_SERVER_PASSWORD, cors)) return next()
    if (sameHost(origin, c.req.header("host"))) return next()
    return c.json({ error: "Cross-origin request denied" }, 403)
  }
